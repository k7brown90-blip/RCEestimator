/**
 * ESTIMATING WITH NO SIGNAL — the phone's half (Phase 7, one-estimating-system plan, 2026-10-09).
 *
 * Kyle, 2026-09-22: "They would have to be able to do estimates and even the diagnostics,
 * electrical assessment, without service."
 *
 * ── THE APPROACH ─────────────────────────────────────────────────────────────────────────────
 * The phone keeps a record of what the tech DID; the server sets every firm price and records
 * every signature. One estimating system, two doors: every queued edit replays through the SAME
 * tech route (and so the same service function) the online phone and the CRM already call, so
 * every business rule still runs on the server, one edit at a time. Nothing here prices anything.
 *
 *  1. Every quote write carries an id this phone minted and `expected` (what the screen showed),
 *     online and offline alike. A replay after a lost answer lands on the same row.
 *  2. An edit is written to IndexedDB FIRST (enqueueQuoteOp), then flushed. It is deleted ONLY
 *     after a 2xx (and the saved copy has been refreshed from the office), a 404 on a remove
 *     (already gone = done), or an explicit Discard. Never silently (constants.md).
 *  3. Flushes fire on app start, on the browser `online` event, and after every queued edit. One
 *     flush at a time; a request mid-run gets exactly one more pass (diagnosticSync's guard, for
 *     the same reason: a run that started before the newest edit existed must not answer for it).
 *  4. Within one draft, edits replay strictly in `seq` order. Drafts are independent.
 *  5. A refusal (4xx with words) stops THAT draft's chain and is never retried on its own — a
 *     later edit may depend on it. The tech sees the server's words and chooses Discard.
 *  6. With no signal the screen renders the saved copy of the office's payload (quoteMirrors)
 *     with the waiting edits laid over it (overlayQuote). The overlay itself NEVER adds, subtracts
 *     or multiplies a money figure. Without a price sheet, a touched line reads "priced when
 *     signal returns" and every aggregate is blank until the office prices it. WITH the saved
 *     price sheet (U3; Kyle, 2026-10-13: every line at its own difficulty), every figure on a
 *     touched quote — untouched lines included — comes from shared/quotePreview over that sheet,
 *     labelled Preview, and the office's figures are not mixed in (one price source at a time).
 *     A price the office sent is shown as the office's; a preview is shown as a preview; nothing
 *     else is shown. Nobody signs a preview.
 *
 * NEVER ON THIS PHONE: labour hours or dollars, a labour unit basis, the billed labour rate, any
 * company cost or cost basis, the per-unit sell price, supplier prices, markup tiers, Synchrony's
 * discount rate or any other Synchrony rate (constants.md "Field app"; pinned by the server's
 * key-set tests and by the source guard in tests/financingEstimator.test.ts — the column names are
 * deliberately not spelled out here, because that guard greps this directory for them).
 *
 * crmSync must not import this module (main.tsx precedent, 2026-09-20): this module imports
 * crmSync for the session settings and the HTTP calls, and registers its own `online` listener.
 */

import {
  db,
  QUOTE_CATALOG_META_KEY,
  QUOTE_PRICE_SHEET_META_KEY,
  type QuoteCatalogRecord,
  type QuoteLinePatch,
  type QuoteMirrorRecord,
  type QuoteOpBody,
  type QuoteOpRecord,
  type ShownFigures,
} from '../db/database'
import {
  CrmRequestError,
  addQuoteLine,
  addQuoteOption,
  editQuoteLine,
  fetchPriceSheet,
  fetchQuote,
  fetchQuoteCatalogSnapshot,
  fetchVisitQuote,
  getCrmSettings,
  isNetworkFailure,
  openQuoteForVisit,
  removeQuoteLine,
  removeQuoteOption,
  saveQuoteLineOrder,
  saveQuoteMirror,
  saveQuoteOptionMeta,
  setQuoteDetails,
  setQuoteDiscount,
  setQuoteOptionsMode,
  type QuoteLine,
  type QuoteState,
} from './crmSync'
import { BASE_OPTIONS, nextFreeOption, type EstimateOptionLetter } from '../../../shared/estimateOptions'
import {
  inSection,
  matchesCatalogSearch,
  type CatalogSection,
  type FieldCatalogPage,
  type FieldCatalogRow,
} from '../../../shared/quoteCatalog'
import { isCurrentSheetRow, type PhonePriceSheet } from '../../../shared/fieldPriceSheet'
import { programmeFor } from '../../../shared/discountProgramme'
import {
  PRICED_WHEN_SIGNAL_RETURNS,
  previewFigures,
  previewMoney,
  previewTotal,
  type PreviewLineStatus,
  type PreviewOption,
} from '../../../shared/quotePreview'

export type { QuoteMirrorRecord, QuoteOpBody, QuoteOpRecord, ShownFigures } from '../db/database'
export type { PhonePriceSheet } from '../../../shared/fieldPriceSheet'

// ─── Queueing ────────────────────────────────────────────────────────────────────────────────

export interface EnqueueQuoteOpInput {
  draftId: string
  visitId: string
  body: QuoteOpBody
  /** Mint one at capture time when the screen needs it before the write; otherwise one is minted here. */
  opId?: string
}

/**
 * Queue one edit. Written to IndexedDB BEFORE anything is attempted over the wire, with the next
 * `seq` for its draft, then a flush is kicked. Returns the row as written.
 *
 * A start-quote also writes the quote's saved copy (origin 'phone', no figure anywhere) in the
 * same transaction when none exists: design §4 keeps `pendingRebase` on the mirror, and a quote
 * started with no signal had no mirror row for the flush to write it to — the "office started one
 * first" answer was silently lost for exactly the case it is about (Phase 7 review, 2026-10-09).
 */
export async function enqueueQuoteOp(input: EnqueueQuoteOpInput): Promise<QuoteOpRecord> {
  const record = await db.transaction('rw', db.quoteOpQueue, db.quoteMirrors, async () => {
    const last = await db.quoteOpQueue
      .where('[draftId+seq]')
      .between([input.draftId, -Infinity], [input.draftId, Infinity])
      .last()
    const row: QuoteOpRecord = {
      opId: input.opId ?? crypto.randomUUID(),
      draftId: input.draftId,
      visitId: input.visitId,
      seq: (last?.seq ?? 0) + 1,
      kind: input.body.kind,
      body: input.body,
      status: 'queued',
      attempts: 0,
      queuedAt: new Date().toISOString(),
    }
    await db.quoteOpQueue.add(row)
    if (input.body.kind === 'start_quote' && !(await db.quoteMirrors.get(input.draftId))) {
      await db.quoteMirrors.add({
        draftId: input.draftId,
        visitId: input.visitId,
        payload: emptyQuoteState(input.draftId, input.body.title),
        snapshotAt: row.queuedAt,
        origin: 'phone',
        pricesNeedReview: false,
        pendingRebase: null,
      })
    }
    return row
  })
  void requestPersistentStorage()
  void flushQuoteQueue({ again: true })
  return record
}

// ─── The Quote screen's one write path (U5, 2026-10-10) ─────────────────────────────────────

export interface QuoteWriteInput {
  draftId: string
  visitId: string
  body: QuoteOpBody
}

export type QuoteWriteOutcome =
  /** The office took it in this call; the saved copy is already the office's fresh answer. */
  | { state: 'delivered'; opId: string }
  /** Still on this phone. `offline` when the phone knows it has no signal or the try never got an answer; else "sending". */
  | { state: 'queued'; opId: string; offline: boolean; reason?: string }

/**
 * Every Quote-screen write, online and offline alike (design §5, "one request shape, two ways to
 * send it"). The edit is written to IndexedDB FIRST and sent at once through the same flush the
 * queue uses, so it carries the id this phone minted and `expected` either way, and a write whose
 * answer is lost replays safely. Three outcomes, as the screen needs them:
 *
 *   - delivered: the office took it NOW. The flush already refreshed the saved copy from the office,
 *     so the screen reads the office's figures off the phone without a second fetch. When nothing
 *     else was waiting on the draft, the tech is looking at those figures as they land, so the
 *     saved copy is not flagged for the "Check the prices" review (U6); with earlier edits queued
 *     ahead of it, it is. A review already OWED (an earlier sync the tech has not checked) is never
 *     cleared by a new edit — otherwise any quantity change would walk round the gate (U6).
 *   - refused: the office said no NOW (4xx with words). The edit is taken OUT of the queue and the
 *     office's own error is thrown, so the refusal prints beside the control exactly as it always
 *     did — it never sits in the queue blocking the draft's later edits, because the tech saw the
 *     words and will try again or not. (A refusal the office gives LATER, to an edit queued with no
 *     signal, stays listed under "Changes waiting" with its words and a Discard — that is the queue's
 *     rule, §5.)
 *   - queued: no answer came (no signal, a timeout, a 5xx, a 401) or an earlier edit on the draft is
 *     still waiting or was refused. The screen renders the overlay and the header says why.
 *
 * Why not call crmSync directly while online and only queue on failure, as the design sketched: a
 * write that LANDED, followed by a refresh that fails because signal dropped in between, would
 * leave the screen showing the old value with nothing waiting — the office has the edit and the
 * phone has no record of it. Through the queue the delivered row stays laid over the saved copy
 * until the office's copy is refreshed, so the screen shows what the tech did (Phase 7 U5 review,
 * 2026-10-10).
 */
export async function writeQuote(input: QuoteWriteInput): Promise<QuoteWriteOutcome> {
  const [pendingBefore, mirrorBefore] = await Promise.all([pendingQuoteOpCount(input.draftId), db.quoteMirrors.get(input.draftId)])
  const reviewOwedBefore = mirrorBefore?.pricesNeedReview ?? false
  const since = Date.now()
  const op = await enqueueQuoteOp(input)
  const outcome = await awaitOp(op.opId)
  if (outcome.state === 'delivered') {
    if (pendingBefore === 0 && !reviewOwedBefore) await markPricesReviewed(input.draftId).catch(() => undefined)
    return { state: 'delivered', opId: op.opId }
  }
  if (outcome.state === 'refused') {
    const original = liveRefusals.get(op.opId)
    liveRefusals.delete(op.opId)
    await db.quoteOpQueue.delete(op.opId)
    throw original ?? new Error(outcome.reason ?? 'The office refused this change.')
  }
  return {
    state: 'queued',
    opId: op.opId,
    offline: phoneKnowsItIsOffline() || lastNetworkFailureAt >= since,
    reason: outcome.reason,
  }
}

/** The office's own error for an edit refused during the flush — handed back by writeQuote, as the control prints it. */
const liveRefusals = new Map<string, unknown>()

/** When a send last failed to get any answer (fetch threw); 0 when never. The screen reads "no signal" off it. */
let lastNetworkFailureAt = 0

export function isPhoneOffline(): boolean {
  return phoneKnowsItIsOffline()
}

/**
 * True after a pass in which the office answered 401 (or the phone holds no session): the queue
 * waits for the tech to sign in again — "Sign in again — N changes waiting" (design §5, U6).
 * Set only by a pass that actually tried the office; a pass skipped for no signal leaves it as it
 * was. Cleared by the next pass the office answers without a 401.
 */
export function quoteSyncNeedsSignIn(): boolean {
  return signInNeeded
}

let signInNeeded = false

/**
 * Listeners told when a flush pass has settled — after an edit was delivered and the saved copy
 * refreshed, or after a try that got no answer. The Quote screen and the Job site re-read the phone
 * on it (loadQuoteView / the waiting count); nothing here fetches on their behalf.
 */
const settledListeners = new Set<() => void>()

export function onQuoteSyncSettled(listener: () => void): () => void {
  settledListeners.add(listener)
  return () => {
    settledListeners.delete(listener)
  }
}

function notifySettled(): void {
  for (const listener of settledListeners) {
    try {
      listener()
    } catch {
      /* a screen's listener must never break the queue */
    }
  }
}

let persistenceAsked = false

/**
 * Ask the browser not to evict IndexedDB under storage pressure — once there is something on this
 * phone that exists nowhere else (a queued edit; U8's queued signature will call this too). Not at
 * app start (Phase 7 review, 2026-10-09): Chrome and Safari answer silently, but Firefox shows the
 * tech a "store data in persistent storage" prompt, and at launch that prompt has no context. Asked
 * at most once per session, and not at all when the browser already says it is persisted. iOS still
 * evicts a site that is not installed to the home screen, and the answer may be "no" — nothing here
 * depends on it, it only lowers the odds. An older browser without the API is simply unchanged.
 */
export async function requestPersistentStorage(): Promise<void> {
  if (persistenceAsked) return
  persistenceAsked = true
  try {
    const storage = typeof navigator !== 'undefined' ? navigator.storage : undefined
    if (!storage?.persist) return
    if (storage.persisted && (await storage.persisted())) return
    await storage.persist()
  } catch {
    /* a refusal, or a browser without the API: the queue is exactly where it was */
  }
}

export interface QuoteOpOutcome {
  /** 'delivered': the office took it. 'refused': the office said no (`reason`). 'waiting': still on the phone (`reason` says why, when known). */
  state: 'delivered' | 'refused' | 'waiting'
  reason?: string
  op?: QuoteOpRecord
}

/** What became of one queued edit, once the flush in flight (or the next one) has had its go. */
export async function awaitOp(opId: string): Promise<QuoteOpOutcome> {
  await flushQuoteQueue()
  return quoteOpOutcome(opId)
}

export async function quoteOpOutcome(opId: string): Promise<QuoteOpOutcome> {
  const op = await db.quoteOpQueue.get(opId)
  if (!op || op.status === 'delivered') return { state: 'delivered', op }
  if (op.status === 'refused') return { state: 'refused', reason: op.refusal, op }
  const blocker = await refusedBefore(op)
  if (blocker) return { state: 'waiting', reason: `Waiting on an earlier change that was refused: ${blocker.refusal ?? ''}`.trim(), op }
  return { state: 'waiting', reason: op.lastError, op }
}

async function refusedBefore(op: QuoteOpRecord): Promise<QuoteOpRecord | undefined> {
  const earlier = await quoteOpsForDraft(op.draftId)
  return earlier.find((o) => o.status === 'refused' && o.seq < op.seq)
}

/** Every edit on the phone for one draft, in replay order (delivered rows included until the saved copy is refreshed). */
export function quoteOpsForDraft(draftId: string): Promise<QuoteOpRecord[]> {
  return db.quoteOpQueue
    .where('[draftId+seq]')
    .between([draftId, -Infinity], [draftId, Infinity])
    .toArray()
}

/** "Changes waiting (N)": queued and refused edits — what has not reached the office, or needs the tech's answer. */
export async function pendingQuoteOpCount(draftId?: string): Promise<number> {
  const rows = draftId ? await quoteOpsForDraft(draftId) : await db.quoteOpQueue.toArray()
  return rows.filter((o) => o.status !== 'delivered').length
}

/** The Job site's "N quote changes waiting" badge: every draft on this visit. */
export async function pendingQuoteOpCountForVisit(visitId: string): Promise<number> {
  const rows = await db.quoteOpQueue.toArray()
  return rows.filter((o) => o.visitId === visitId && o.status !== 'delivered').length
}

// ─── Flushing ────────────────────────────────────────────────────────────────────────────────

export interface QuoteFlushResult {
  pushed: number
  /** Queued + refused rows left on the phone. */
  remaining: number
  refused: number
  /** A 401 stopped the pass: "Sign in again — N changes waiting". */
  authNeeded: boolean
}

/*
  Same guard as diagnosticSync, for the same reason: a flush can be requested from several places
  that overlap (every enqueue, the online listener, app start, awaitOp). A request that arrives
  DURING a run joins it; one made because something CHANGED (an edit was queued — the run may
  already be past its draft — or signal came back) schedules exactly one more pass (`again`), and
  every caller waits for the whole chain. So an edit queued mid-run is still sent before anyone
  is told "flushed", and a screen that only waits (awaitOp) never buys a second try.
*/
let quoteFlushInFlight: Promise<QuoteFlushResult> | null = null
let quoteFlushRerun = false

export function flushQuoteQueue(opts: { again?: boolean } = {}): Promise<QuoteFlushResult> {
  if (quoteFlushInFlight) {
    if (opts.again) quoteFlushRerun = true
    return quoteFlushInFlight
  }
  const pass = (): Promise<QuoteFlushResult> =>
    runQuoteFlush().then((result) => {
      notifySettled()
      if (!quoteFlushRerun) return result
      quoteFlushRerun = false
      return pass()
    })
  quoteFlushInFlight = pass().finally(() => {
    quoteFlushInFlight = null
    quoteFlushRerun = false
  })
  return quoteFlushInFlight
}

async function runQuoteFlush(): Promise<QuoteFlushResult> {
  try {
    return await drainQuoteQueue()
  } catch {
    // A DRAIN may fail; a CAPTURE may not. Every row is exactly where it was.
    return { pushed: 0, authNeeded: false, ...(await queueSummary().catch(() => ({ remaining: 0, refused: 0 }))) }
  }
}

async function queueSummary(): Promise<{ remaining: number; refused: number }> {
  const rows = await db.quoteOpQueue.toArray()
  return {
    remaining: rows.filter((o) => o.status !== 'delivered').length,
    refused: rows.filter((o) => o.status === 'refused').length,
  }
}

function phoneKnowsItIsOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false
}

async function drainQuoteQueue(): Promise<QuoteFlushResult> {
  // No session, or the phone KNOWS it has no signal: nothing is attempted and nothing is counted
  // as a failed attempt. (`onLine === true` proves nothing, so a fetch is still tried then.)
  if (!getCrmSettings() || phoneKnowsItIsOffline()) {
    return { pushed: 0, authNeeded: false, ...(await queueSummary()) }
  }

  const all = await db.quoteOpQueue.orderBy('seq').toArray()
  const byDraft = new Map<string, QuoteOpRecord[]>()
  for (const op of all) {
    const list = byDraft.get(op.draftId)
    if (list) list.push(op)
    else byDraft.set(op.draftId, [op])
  }

  let pushed = 0
  let authNeeded = false
  for (const [draftId, ops] of byDraft) {
    if (authNeeded) break
    const visitId = ops[0].visitId
    let delivered = ops.some((o) => o.status === 'delivered')
    // A refused edit stops the draft's chain until the tech discards it — a later edit may
    // depend on it (an edit to a line whose add was refused), and a refusal is never retried.
    const stopped = ops.some((o) => o.status === 'refused')
    if (!stopped) {
      for (const stale of ops) {
        if (stale.status !== 'queued') continue
        // The list above is a snapshot taken before the first request went out; a request can hang
        // on weak signal, and meanwhile the tech may Discard (or rebase, or delete the quote). The
        // row is read again right before it is sent, and sent only if it is still this queued edit
        // on this draft — Discard is an exit, and an exit must not reach the office (Phase 7 review,
        // 2026-10-09). The edit IN FLIGHT is guarded the other way round: the exits refuse to touch it.
        const op = await db.quoteOpQueue.get(stale.opId)
        if (!op || op.status !== 'queued' || op.draftId !== draftId || op.seq !== stale.seq) continue
        sendingOpId = op.opId
        let answer: SendAnswer
        try {
          answer = await sendOp(op)
        } finally {
          sendingOpId = null
        }
        if (answer.kind === 'ok') {
          await db.quoteOpQueue.update(op.opId, { status: 'delivered', lastError: undefined })
          delivered = true
          pushed += 1
          continue
        }
        if (answer.kind === 'refused') {
          await db.quoteOpQueue.update(op.opId, {
            status: 'refused',
            attempts: op.attempts + 1,
            refusal: answer.message,
            refusalCode: answer.code,
            existingDraftId: answer.existingDraftId,
            lastError: answer.message,
          })
          liveRefusals.set(op.opId, answer.error)
          if (op.kind === 'start_quote' && answer.existingDraftId) {
            await recordPendingRebase(op, answer.existingDraftId)
          }
          break
        }
        // transient or auth: keep it, count the attempt, and stop this draft's chain to keep the order.
        await db.quoteOpQueue.update(op.opId, { attempts: op.attempts + 1, lastError: answer.message, lastErrorKind: answer.errorKind })
        if (answer.kind === 'auth') authNeeded = true
        if (answer.network) lastNetworkFailureAt = Date.now()
        break
      }
    }
    // The office took something: refresh the saved copy from the office — the one place the
    // phone gets prices for what it sent — and only then let the delivered rows go.
    if (delivered) await refreshMirrorAfterDelivery(draftId, visitId)
  }

  signInNeeded = authNeeded
  return { pushed, authNeeded, ...(await queueSummary()) }
}

/** The one edit on the wire right now (sends are one at a time), or null. The exits below refuse to touch it. */
let sendingOpId: string | null = null

function refuseIfInFlight(opIds: Iterable<string>): void {
  for (const id of opIds) {
    if (id === sendingOpId) {
      throw new Error('That change is being sent to the office right now — try again in a moment.')
    }
  }
}

/**
 * "The office already started a quote for this visit": `pendingRebase` lives on the quote's saved
 * copy (design §4). The copy is written when the start-quote is queued (enqueueQuoteOp), so this is
 * an update — but a put when the row is somehow gone, because Dexie's update on a missing key does
 * nothing and says nothing, and this answer must never be dropped.
 */
async function recordPendingRebase(op: QuoteOpRecord, existingDraftId: string): Promise<void> {
  await db.transaction('rw', db.quoteMirrors, async () => {
    const mirror = await db.quoteMirrors.get(op.draftId)
    if (mirror) {
      await db.quoteMirrors.update(op.draftId, { pendingRebase: existingDraftId })
      return
    }
    await db.quoteMirrors.put({
      draftId: op.draftId,
      visitId: op.visitId,
      payload: emptyQuoteState(op.draftId, op.body.kind === 'start_quote' ? op.body.title : undefined),
      snapshotAt: new Date().toISOString(),
      origin: 'phone',
      pricesNeedReview: false,
      pendingRebase: existingDraftId,
    })
  })
}

type SendAnswer =
  | { kind: 'ok' }
  /**
   * `network`: fetch threw — no answer at all (no signal), as opposed to a 5xx the office did send.
   * `errorKind` (D7): what the change's row says — 'network' waits for signal, 'office' waits for
   * the office, 'phone' is this phone's own code failing, said as such, never "waiting for signal".
   */
  | { kind: 'transient' | 'auth'; message: string; network?: boolean; errorKind: 'network' | 'office' | 'phone' }
  /** `error`: the office's own thrown error, for writeQuote to hand the control that pressed. */
  | { kind: 'refused'; message: string; code?: string; existingDraftId?: string; error: unknown }

async function sendOp(op: QuoteOpRecord): Promise<SendAnswer> {
  try {
    await deliver(op)
    return { kind: 'ok' }
  } catch (error) {
    return classifyAnswer(error, op)
  }
}

/** One edit = one existing crmSync call = one existing tech route. No rule lives here. */
async function deliver(op: QuoteOpRecord): Promise<void> {
  const b = op.body
  switch (b.kind) {
    case 'start_quote':
      await openQuoteForVisit(op.visitId, op.draftId)
      return
    case 'add_line':
      await addQuoteLine(
        op.draftId,
        { itemId: b.itemId, quantity: b.quantity, difficulty: b.difficulty, option: b.option, note: b.note, location: b.location },
        b.lineId,
      )
      return
    case 'edit_line':
      await editQuoteLine(b.lineId, b.patch, b.expected)
      return
    case 'remove_line':
      await removeQuoteLine(b.lineId)
      return
    case 'add_option':
      await addQuoteOption(op.draftId, b.option)
      return
    case 'remove_option':
      await removeQuoteOption(op.draftId, b.option, b.expectedLines)
      return
    case 'set_option_meta':
      await saveQuoteOptionMeta(op.draftId, b.option, { label: b.label, note: b.note }, b.expected)
      return
    case 'set_discount':
      await setQuoteDiscount(op.draftId, { type: b.type, percent: b.percent }, b.expected)
      return
    case 'set_mode':
      await setQuoteOptionsMode(op.draftId, b.exclusive, b.expected)
      return
    case 'set_details':
      await setQuoteDetails(op.draftId, { title: b.title, jobDescription: b.jobDescription }, b.expected)
      return
    case 'line_order':
      await saveQuoteLineOrder(op.draftId, b.order)
      return
  }
}

/**
 * The answer table (design §5):
 *   2xx                      done
 *   network error            keep, attempts+1 ("Waiting for signal")
 *   5xx                      keep, attempts+1 ("The office could not take it yet")
 *   this phone's code threw  keep, attempts+1, said as THIS phone's failure (D7) — not "waiting for signal"
 *   401 / no session         keep ("Sign in again")
 *   408 / 429                keep, attempts+1 — the office's rate limiter (600/min on the API) or
 *                            a request timeout is "not now", not "no"; a refusal here would stop
 *                            the draft for good and the only way out would be Discard, dropping
 *                            a valid edit (Phase 7 review, 2026-10-09)
 *   400 / 403 / 409 / 422    refused with the server's own words; that draft's chain stops
 *   404 on a remove          done (already gone)
 *   404 otherwise            refused ("The office removed this line")
 */
function classifyAnswer(error: unknown, op: QuoteOpRecord): SendAnswer {
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof CrmRequestError) {
    const status = error.status
    const errorBody = (error.body as { error?: { code?: string; existingDraftId?: string } } | null)?.error
    if (status === 401) return { kind: 'auth', message, errorKind: 'office' }
    if (status === 408 || status === 429) return { kind: 'transient', message, errorKind: 'office' }
    if (status === 404 && (op.kind === 'remove_line' || op.kind === 'remove_option')) return { kind: 'ok' }
    // A 200 carrying `success: false` is the server saying no with words, not an outage.
    if (status === undefined || (status >= 400 && status < 500)) {
      return { kind: 'refused', message, code: errorBody?.code, existingDraftId: errorBody?.existingDraftId, error }
    }
    return { kind: 'transient', message, errorKind: 'office' }
  }
  if (message === 'CRM not configured') return { kind: 'auth', message, errorKind: 'office' }
  // Not an HTTP answer. Only what `fetch` itself threw is "no signal" (crmSync.CrmNetworkError, D7);
  // anything else is this phone's own code failing, kept with its message and said as such.
  const network = isNetworkFailure(error)
  return { kind: 'transient', message, network, errorKind: network ? 'network' : 'phone' }
}

async function refreshMirrorAfterDelivery(draftId: string, visitId: string): Promise<void> {
  try {
    // What this phone SHOWED for these lines (the saved copy with the queue laid over — the
    // delivered rows are still in it at this point), noted BEFORE the office's answer replaces it,
    // so "Check the prices" (U6) can put the two side by side. A note already owed stands: a sync
    // that lands in several passes compares with what the tech built against, not with the
    // half-way copy of an earlier pass.
    const existing = await db.quoteMirrors.get(draftId)
    const shown = existing?.pricesNeedReview && existing.shownBeforeSync ? undefined : shownFigures(await loadQuoteView(draftId))
    const quote = await fetchQuote(draftId, { visitId })
    // The office priced what landed and the tech has not looked yet (U6's "Check the prices").
    await saveQuoteMirror(quote, { visitId, origin: 'server', pricesNeedReview: true, shownBeforeSync: shown })
    await db.quoteOpQueue.where('draftId').equals(draftId).filter((o) => o.status === 'delivered').delete()
  } catch {
    // The saved copy stays as it was and the delivered rows stay overlaid on it; the next flush
    // tries the refresh again. Nothing is re-sent — the rows are marked delivered.
  }
}

/**
 * The figures AS THE SCREEN SHOWED THEM — named fields only (a line's id, words and figure; an
 * option's letter and subtotal; the headline), never a cost, an hour or the queue. This is the
 * phone's half of "Check the prices": the office's answer is later laid beside it for equality.
 */
export function shownFigures(view: QuoteView): ShownFigures {
  return {
    at: new Date().toISOString(),
    source: view.priceSource,
    lines: view.lines
      .filter((l) => l.state !== 'PROPOSED')
      .map((l) => ({ id: l.id, description: l.description, total: l.lineTotal })),
    options: view.options.map((o) => ({ option: o.option, subtotal: o.subtotal })),
    total: view.total,
  }
}

/** Re-flush whenever connectivity returns. Registered from main.tsx, beside the other queues' listeners. */
export function registerQuoteSyncListener(): void {
  window.addEventListener('online', () => {
    void flushQuoteQueue({ again: true })
  })
}

// ─── Exits for what exists only on this phone ───────────────────────────────────────────────

/**
 * "Discard" on one waiting change. A change that depended on it goes with it — an edit to a line
 * whose add is discarded, a line put into an option whose add is discarded — and all of them are
 * returned so the screen can say which went. Discarding a start-quote discards every change on
 * that draft. A delivered change cannot be discarded: it is already at the office.
 */
export async function discardQuoteOp(opId: string): Promise<{ discarded: QuoteOpRecord[] }> {
  return db.transaction('rw', db.quoteOpQueue, db.quoteMirrors, async () => {
    const op = await db.quoteOpQueue.get(opId)
    if (!op) return { discarded: [] }
    if (op.status === 'delivered') {
      throw new Error('This change already reached the office — it can only be changed there now.')
    }
    const later = (await quoteOpsForDraft(op.draftId)).filter((o) => o.seq > op.seq && o.status !== 'delivered')
    const victims: QuoteOpRecord[] = [op]
    if (op.kind === 'start_quote') {
      victims.push(...later)
    } else {
      // Transitive: a line added into a discarded option, then an edit to that line. Only an edit
      // AFTER a victim can depend on it — a victim found through the chain may sit later in the
      // queue than a candidate, and that candidate's expected never came from it.
      let grew = true
      while (grew) {
        grew = false
        for (const candidate of later) {
          if (victims.includes(candidate)) continue
          if (victims.some((v) => candidate.seq > v.seq && dependsOn(candidate, v))) {
            victims.push(candidate)
            grew = true
          }
        }
      }
    }
    refuseIfInFlight(victims.map((v) => v.opId))
    await db.quoteOpQueue.bulkDelete(victims.map((v) => v.opId))
    for (const v of victims) liveRefusals.delete(v.opId)
    if (op.kind === 'start_quote' && op.existingDraftId) {
      await db.quoteMirrors.update(op.draftId, { pendingRebase: null })
    }
    return { discarded: victims.sort((a, b) => a.seq - b.seq) }
  })
}

/** "Discard all N waiting changes" on a draft. Delivered rows stay (they are the office's now). */
export async function discardAllQuoteOps(draftId: string): Promise<{ discarded: QuoteOpRecord[] }> {
  return db.transaction('rw', db.quoteOpQueue, db.quoteMirrors, async () => {
    const victims = (await quoteOpsForDraft(draftId)).filter((o) => o.status !== 'delivered')
    refuseIfInFlight(victims.map((v) => v.opId))
    await db.quoteOpQueue.bulkDelete(victims.map((v) => v.opId))
    for (const v of victims) liveRefusals.delete(v.opId)
    await db.quoteMirrors.update(draftId, { pendingRebase: null })
    return { discarded: victims }
  })
}

/**
 * Does `later` only make sense if `earlier` reached the office? Two ways:
 *   - it names something `earlier` creates (a line, an option, the quote itself);
 *   - its `expected` was read off the screen AFTER `earlier` was laid over it (expectedForLine /
 *     the settings' expected), so it carries `earlier`'s value as "what I saw". Discard `earlier`
 *     alone and `later` replays with an `expected` the office never held — refused 409 "Changed at
 *     the office since you last saw it" for a change the office never made, and that refusal stops
 *     the draft's chain (Phase 7 review, 2026-10-09). So a second edit to the SAME field of the same
 *     line, a second setting of the same kind (same option for a name), and a second order after a
 *     first, go with the first. An edit to a DIFFERENT field of the same line does not: its expected
 *     came from the office's copy.
 */
function dependsOn(later: QuoteOpRecord, earlier: QuoteOpRecord): boolean {
  const l = later.body
  const e = earlier.body
  if (e.kind === 'start_quote') return true
  if (e.kind === 'add_line') {
    if ((l.kind === 'edit_line' || l.kind === 'remove_line') && l.lineId === e.lineId) return true
    if (l.kind === 'line_order' && l.order.some((row) => row.lineId === e.lineId)) return true
    return false
  }
  if (e.kind === 'add_option') {
    const letter = e.option
    if ((l.kind === 'set_option_meta' || l.kind === 'remove_option') && l.option === letter) return true
    if (l.kind === 'add_line' && l.option === letter) return true
    if (l.kind === 'edit_line' && l.patch.option === letter) return true
    if (l.kind === 'line_order' && l.order.some((row) => row.option === letter || row.was === letter)) return true
    return false
  }
  if (e.kind === 'edit_line') {
    if (l.kind === 'edit_line' && l.lineId === e.lineId) {
      return Object.keys(e.patch).some((field) => field in l.patch)
    }
    // The order's `was` is the option as the screen showed it — the earlier edit's, if it moved the line.
    if (l.kind === 'line_order' && e.patch.option !== undefined) return l.order.some((row) => row.lineId === e.lineId)
    return false
  }
  if (e.kind === 'line_order') {
    if (l.kind === 'line_order') return true
    // An edit that moves a line the order had already moved: its expected.option is the order's.
    if (l.kind === 'edit_line' && l.patch.option !== undefined) {
      return e.order.some((row) => row.lineId === l.lineId && row.was !== undefined && row.was !== row.option)
    }
    return false
  }
  if (e.kind === 'set_discount' || e.kind === 'set_mode' || e.kind === 'set_details') return l.kind === e.kind
  if (e.kind === 'set_option_meta') return l.kind === 'set_option_meta' && l.option === e.option
  return false
}

export interface RebaseOptions {
  /**
   * The ids of the tech's SETTINGS edits (title/scope, discount, mode, option names) to apply to
   * the office's draft — each one the tech answered "Apply mine too?" to. The rest are dropped
   * and returned. Line and option edits always move.
   */
  applySettings?: readonly string[]
  /**
   * The office's draft as fetched (GET /quotes/:draftId): an applied setting is sent with the
   * office's CURRENT value as `expected`, so nothing is overwritten silently if it moves again.
   */
  office?: QuoteState | null
}

/**
 * "Add my N lines to it": the office started this visit's quote first (start-quote answered 409
 * with `existingDraftId`), so the tech's queued edits are re-pointed at the office's draft. The
 * client ids on the lines keep the replay idempotent; the start-quote itself is dropped. The
 * moved edits take seq numbers after anything already waiting on the target, in their old order.
 */
export async function rebaseQuoteOps(
  from: string,
  to: string,
  opts: RebaseOptions = {},
): Promise<{ moved: QuoteOpRecord[]; dropped: QuoteOpRecord[] }> {
  if (from === to) return { moved: [], dropped: [] }
  const apply = new Set(opts.applySettings ?? [])
  return db.transaction('rw', db.quoteOpQueue, db.quoteMirrors, async () => {
    const ops = await quoteOpsForDraft(from)
    if (ops.some((o) => o.status === 'delivered')) {
      throw new Error('Part of this quote already reached the office — it cannot be moved onto another quote.')
    }
    refuseIfInFlight(ops.map((o) => o.opId))
    const target = await quoteOpsForDraft(to)
    let seq = target.length > 0 ? target[target.length - 1].seq : 0
    const moved: QuoteOpRecord[] = []
    const dropped: QuoteOpRecord[] = []
    for (const op of ops) {
      if (op.kind === 'start_quote') {
        await db.quoteOpQueue.delete(op.opId)
        continue
      }
      if (isSettingsOp(op) && !apply.has(op.opId)) {
        await db.quoteOpQueue.delete(op.opId)
        dropped.push(op)
        continue
      }
      seq += 1
      const body = isSettingsOp(op) && opts.office ? withOfficeExpected(op.body, opts.office) : op.body
      const next: QuoteOpRecord = {
        ...op,
        draftId: to,
        seq,
        body,
        status: 'queued',
        attempts: 0,
        lastError: undefined,
        refusal: undefined,
        refusalCode: undefined,
        existingDraftId: undefined,
      }
      await db.quoteOpQueue.put(next)
      moved.push(next)
    }
    // The phone-only draft is gone; the office's draft is the quote now.
    await db.quoteMirrors.delete(from)
    await db.quoteMirrors.update(to, { pendingRebase: null })
    return { moved, dropped }
  })
}

/** Title/scope, discount, mode and option names: the edits a rebase asks "Apply mine too?" about. */
export function isSettingsOp(op: Pick<QuoteOpRecord, 'kind'>): boolean {
  return op.kind === 'set_details' || op.kind === 'set_discount' || op.kind === 'set_mode' || op.kind === 'set_option_meta'
}

/** "Add my N lines to it" with no signal: greyed WITH this reason (the office's quote is read first). */
export const REBASE_NEEDS_SIGNAL = "Needs signal — the office's quote is read first, so nothing of theirs is overwritten"

/**
 * The "Add my N lines to it" button (U6, design §5): read the office's draft as it stands NOW —
 * fetchQuote, which also saves it on this phone so the screen can open it — then re-point the
 * tech's queued edits at it (rebaseQuoteOps), each chosen setting carrying the office's current
 * value as `expected`, and kick a flush so they replay. With no answer from the office nothing is
 * moved: a rebase against a stale copy would send `expected` values the office never held and
 * stop the chain with a refusal for a change the office never made.
 */
export async function applyRebase(
  from: string,
  to: string,
  visitId: string,
  opts: { applySettings?: readonly string[] } = {},
): Promise<{ moved: QuoteOpRecord[]; dropped: QuoteOpRecord[] }> {
  let office: QuoteState
  try {
    office = await fetchQuote(to, { visitId })
  } catch (error) {
    if (isNetworkFailure(error)) throw new Error(REBASE_NEEDS_SIGNAL)
    throw error
  }
  const result = await rebaseQuoteOps(from, to, { applySettings: opts.applySettings, office })
  void flushQuoteQueue({ again: true })
  return result
}

/**
 * The "[Discard them]" button on the same prompt: the quote this phone started, and every edit on
 * it, go — the office's quote for the visit is the quote now. The same exit as "Delete this quote"
 * on a phone-only quote (deleteLocalOnlyQuote), under the prompt's own words.
 */
export function discardRebase(from: string): Promise<{ deleted: true; changes: number }> {
  return deleteLocalOnlyQuote(from)
}

/**
 * `expected` = the office's current value. The discount's `percent` compares with the STORED
 * percent, which the server keeps only for a custom programme — so a military/senior row's
 * displayed 5 must NOT be sent (it would read as "changed at the office").
 */
function withOfficeExpected(body: QuoteOpBody, office: QuoteState): QuoteOpBody {
  switch (body.kind) {
    case 'set_details':
      return { ...body, expected: { title: office.title, jobDescription: office.jobDescription } }
    case 'set_discount': {
      const d = office.money.discount
      return { ...body, expected: { type: d?.type ?? null, percent: d?.type === 'custom' ? d.percent : null } }
    }
    case 'set_mode':
      return { ...body, expected: { exclusive: office.money.exclusiveOptions } }
    case 'set_option_meta': {
      const entry = office.optionSet.options.find((o) => o.option === body.option)
      return { ...body, expected: { label: entry?.label ?? null, note: entry?.note ?? null } }
    }
    default:
      return body
  }
}

/**
 * "Delete this quote" on a quote the office has never received. Refused — with why — once the
 * office has it: that exit is the online "Delete this quote", so the office's copy goes too.
 */
export async function deleteLocalOnlyQuote(draftId: string): Promise<{ deleted: true; changes: number }> {
  return db.transaction('rw', db.quoteOpQueue, db.quoteMirrors, async () => {
    const mirror = await db.quoteMirrors.get(draftId)
    const ops = await quoteOpsForDraft(draftId)
    if (mirror?.origin === 'server' || ops.some((o) => o.status === 'delivered')) {
      throw new Error('The office has this quote — delete it from the quote screen when you have signal, so the office\'s copy goes too.')
    }
    refuseIfInFlight(ops.map((o) => o.opId))
    await db.quoteOpQueue.bulkDelete(ops.map((o) => o.opId))
    await db.quoteMirrors.delete(draftId)
    return { deleted: true, changes: ops.length }
  })
}

/**
 * Drop the saved copies this phone no longer needs: a quote on a visit that is no longer assigned
 * (the office reassigned or closed it), when nothing on this phone still waits on it. A copy is the
 * office's payload as received — it carries the customer's estimate-page link — and before Phase 7
 * that lived only in memory while the screen was open, so a copy must not outlive its visit
 * (Phase 7 review, 2026-10-09). A draft with a queued or refused edit is kept whatever its visit:
 * the overlay renders on it, and nothing waiting is ever dropped silently. Called by
 * cacheVisitQuotes after the assignment sync has replaced the list.
 */
export async function pruneQuoteMirrors(opts: { keepVisitIds?: Iterable<string> } = {}): Promise<{ pruned: number }> {
  const keep = new Set(opts.keepVisitIds ?? (await db.assignments.toArray()).map((a) => a.visitId))
  return db.transaction('rw', db.quoteMirrors, db.quoteOpQueue, async () => {
    const mirrors = await db.quoteMirrors.toArray()
    const waiting = new Set((await db.quoteOpQueue.toArray()).filter((o) => o.status !== 'delivered').map((o) => o.draftId))
    const gone = mirrors.filter((m) => !(m.visitId && keep.has(m.visitId)) && !waiting.has(m.draftId))
    await db.quoteMirrors.bulkDelete(gone.map((m) => m.draftId))
    return { pruned: gone.length }
  })
}

/**
 * "Disconnect this device": every saved copy whose draft has nothing waiting goes, with the token.
 * The ones with waiting edits stay — they are the tech's work, and the next sign-in sends them.
 */
export async function forgetOfficeCopies(): Promise<{ pruned: number }> {
  return pruneQuoteMirrors({ keepVisitIds: [] })
}

// ─── The saved copy ─────────────────────────────────────────────────────────────────────────

export { saveQuoteMirror as saveMirror } from './crmSync'

export function quoteMirror(draftId: string): Promise<QuoteMirrorRecord | undefined> {
  return db.quoteMirrors.get(draftId)
}

/**
 * The office deleted the quote (the online "Delete this quote"): its saved copy goes too, so that
 * with no signal "Build the quote" cannot open a quote that no longer exists and queue edits the
 * office would only refuse. Refused while anything still waits on it — those edits are the tech's.
 */
export async function forgetQuoteMirror(draftId: string): Promise<void> {
  await db.transaction('rw', db.quoteMirrors, db.quoteOpQueue, async () => {
    const waiting = (await quoteOpsForDraft(draftId)).some((o) => o.status !== 'delivered')
    if (waiting) throw new Error('Changes are still waiting on this quote — discard them first.')
    await db.quoteOpQueue.where('draftId').equals(draftId).delete()
    await db.quoteMirrors.delete(draftId)
  })
}

export function quoteMirrorForVisit(visitId: string): Promise<QuoteMirrorRecord | undefined> {
  return db.quoteMirrors.where('visitId').equals(visitId).first()
}

/**
 * The copy "Build the quote" opens with no signal: the visit's WORKING quote — never a change
 * order (the server's workingDraftForVisit will not return one either; a change order is opened
 * by id or not at all) — and the newest saved when the visit has more than one (a "Copy to a new
 * quote" leaves the older draft's copy behind until the pass that prunes it).
 */
export async function workingQuoteMirrorForVisit(visitId: string): Promise<QuoteMirrorRecord | undefined> {
  const mirrors = await db.quoteMirrors.where('visitId').equals(visitId).toArray()
  return mirrors
    .filter((m) => !m.payload.isChangeOrder)
    .sort((a, b) => b.snapshotAt.localeCompare(a.snapshotAt))[0]
}

/** "I've checked the prices" (U6): the office's figures for what this phone sent have been looked at; the note of what the phone showed goes with the gate. */
export async function markPricesReviewed(draftId: string): Promise<void> {
  await db.quoteMirrors.update(draftId, { pricesNeedReview: false, shownBeforeSync: null })
}

/**
 * Save every assigned visit's quote at assignment sync, so a phone that loses signal in the
 * driveway opens the quote it would have opened — not only one somebody happened to look at.
 * READ-ONLY on the server (GET, never the POST that starts a quote). A visit with no quote is
 * skipped. Each visit is its own try: one failure never costs the others their copy.
 */
export async function cacheVisitQuotes(): Promise<{ cached: number; none: number; failed: number }> {
  const result = { cached: 0, none: 0, failed: 0 }
  if (!getCrmSettings() || phoneKnowsItIsOffline()) return result
  const assignments = await db.assignments.toArray()
  for (const assignment of assignments) {
    try {
      const found = await fetchVisitQuote(assignment.visitId)
      if (!found) {
        result.none += 1
        continue
      }
      await fetchQuote(found.draftId, { visitId: assignment.visitId })
      result.cached += 1
    } catch {
      result.failed += 1
    }
  }
  // The copies of visits that have left the list go (nothing waiting on them) — see pruneQuoteMirrors.
  await pruneQuoteMirrors({ keepVisitIds: assignments.map((a) => a.visitId) }).catch(() => undefined)
  return result
}

// ─── The price book on the phone ────────────────────────────────────────────────────────────

/**
 * The online picker's page size (atomicEstimateService.FIELD_CATALOG_LIMIT, server-side) — the
 * offline list is cut at the same point so both read alike. Restated here because the server's
 * module is never bundled into the phone.
 */
export const CACHED_CATALOG_PAGE = 60

export interface QuoteCatalogMeta {
  version: string
  /** Server time the snapshot was cut. */
  generatedAt: string
  /** When this phone saved it — "Price book saved on this phone at 7:02 AM". */
  cachedAt: string
  sections: CatalogSection[]
  count: number
}

export interface CatalogSyncResult {
  /** True when nothing could be fetched and the saved copy (if any) stands. */
  stale: boolean
  /** True when the server said the saved copy is already current. */
  unchanged: boolean
  meta: QuoteCatalogMeta | null
  error?: string
}

export async function cachedCatalogMeta(): Promise<QuoteCatalogMeta | null> {
  const row = await db.meta.get(QUOTE_CATALOG_META_KEY)
  return (row?.value as QuoteCatalogMeta | undefined) ?? null
}

/**
 * Refresh the saved price book. Sends the saved version so an unchanged book costs one small
 * answer; otherwise prune + bulkPut in ONE transaction (syncMaterials' pattern) so an item retired
 * at the office disappears here too and a reader never sees half a book. On failure the saved
 * copy stands.
 */
export async function syncQuoteCatalog(): Promise<CatalogSyncResult> {
  const have = await cachedCatalogMeta()
  try {
    const answer = await fetchQuoteCatalogSnapshot(have?.version ?? null)
    if ('unchanged' in answer) return { stale: false, unchanged: true, meta: have }
    const now = new Date().toISOString()
    const rows: QuoteCatalogRecord[] = answer.rows.map((row, position) => ({ ...row, position }))
    const meta: QuoteCatalogMeta = {
      version: answer.version,
      generatedAt: answer.generatedAt,
      cachedAt: now,
      sections: answer.sections,
      count: rows.length,
    }
    await db.transaction('rw', db.quoteCatalog, db.meta, async () => {
      await db.quoteCatalog.clear()
      if (rows.length > 0) await db.quoteCatalog.bulkPut(rows)
      await db.meta.put({ key: QUOTE_CATALOG_META_KEY, value: meta, updatedAt: now })
    })
    return { stale: false, unchanged: false, meta }
  } catch (error) {
    return { stale: true, unchanged: false, meta: have, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * The picker with no signal: the same test the online picker runs (shared matchesCatalogSearch /
 * inSection), over the saved copy, in the server's order, cut at the same page size, with the
 * same `truncated` / `total` answer shape.
 */
export async function searchCachedCatalog(
  opts: { search?: string | null; section?: string | null; limit?: number } = {},
): Promise<FieldCatalogPage> {
  const limit = opts.limit ?? CACHED_CATALOG_PAGE
  const rows = await db.quoteCatalog.orderBy('position').toArray()
  const matched: FieldCatalogRow[] = []
  for (const cached of rows) {
    const row = withoutPosition(cached)
    if (inSection(row, opts.section) && matchesCatalogSearch(row, opts.search)) matched.push(row)
  }
  return {
    atomics: matched.slice(0, limit),
    count: Math.min(matched.length, limit),
    total: matched.length,
    truncated: matched.length > limit,
  }
}

function withoutPosition(row: QuoteCatalogRecord): FieldCatalogRow {
  const { position, ...rest } = row
  void position
  return rest
}

/** The saved rows for the items the queued adds name — what overlayQuote needs to describe a new line. */
export async function cachedCatalogRows(itemIds: Iterable<string>): Promise<Map<string, FieldCatalogRow>> {
  const ids = [...new Set(itemIds)]
  const rows = ids.length > 0 ? await db.quoteCatalog.bulkGet(ids) : []
  const map = new Map<string, FieldCatalogRow>()
  for (const row of rows) {
    if (!row) continue
    map.set(row.itemId, withoutPosition(row))
  }
  return map
}

// ─── The price sheet on the phone (U3, Kyle's ruling 8) ─────────────────────────────────────

/** The sheet as saved: the server's sheet plus when this phone saved it ("Prices saved on this phone at 7:02 AM"). */
export interface CachedPriceSheet extends PhonePriceSheet {
  cachedAt: string
}

export interface PriceSheetSyncResult {
  /** True when nothing could be fetched and the saved sheet (if any) stands. */
  stale: boolean
  /** True when the server said the saved sheet is already current. */
  unchanged: boolean
  sheet: CachedPriceSheet | null
  error?: string
}

/**
 * The sheet saved on this phone, or null. A sheet saved by an earlier build (Normal only,
 * 2026-10-09 — one price per row, one gap sentence) is NOT handed back: Kyle, 2026-10-13, every
 * line previews at its own difficulty, and a row that does not carry the three cannot do that.
 * Such a sheet reads as "none saved" (every touched line "priced when signal returns" — never a
 * figure at the wrong difficulty, never a crash) until the next sync replaces it, which sends no
 * version so the office sends the whole current sheet.
 */
export async function cachedPriceSheet(): Promise<CachedPriceSheet | null> {
  const row = await db.meta.get(QUOTE_PRICE_SHEET_META_KEY)
  const sheet = (row?.value as CachedPriceSheet | undefined) ?? null
  if (!sheet || !Array.isArray(sheet.rows) || !sheet.rows.every(isCurrentSheetRow)) return null
  return sheet
}

/**
 * Refresh the saved price sheet (one customer price per live item at EACH difficulty, built by
 * the office's engine — crmSync.fetchPriceSheet). Sends the saved version so an unchanged sheet
 * costs one small answer; otherwise the whole sheet is replaced in ONE put, so a reader never sees
 * half of it. On failure the saved sheet stands.
 */
export async function syncPriceSheet(): Promise<PriceSheetSyncResult> {
  const have = await cachedPriceSheet()
  try {
    const answer = await fetchPriceSheet(have?.version ?? null)
    if ('unchanged' in answer) return { stale: false, unchanged: true, sheet: have }
    const now = new Date().toISOString()
    const sheet: CachedPriceSheet = {
      version: answer.version,
      generatedAt: answer.generatedAt,
      supplierId: answer.supplierId,
      tripCharge: answer.tripCharge,
      rateProvisional: answer.rateProvisional,
      rows: answer.rows,
      cachedAt: now,
    }
    await db.meta.put({ key: QUOTE_PRICE_SHEET_META_KEY, value: sheet, updatedAt: now })
    return { stale: false, unchanged: false, sheet }
  } catch (error) {
    return { stale: true, unchanged: false, sheet: have, error: error instanceof Error ? error.message : String(error) }
  }
}

/** Forget the saved sheet (nothing waits on it; the next sync fetches a fresh one). */
export async function forgetPriceSheet(): Promise<void> {
  await db.meta.delete(QUOTE_PRICE_SHEET_META_KEY)
}

// ─── The overlay: the saved copy with the waiting edits laid over it ────────────────────────

export interface QuoteViewLine extends QuoteLine {
  /** True: "Priced when signal returns" — no figure is shown for this line as it now stands. */
  pendingPrice: boolean
  /** True: added on this phone; the office has never had it. */
  localOnly: boolean
  /** The waiting edits that touch this line. */
  pendingOpIds: string[]
  /**
   * Where this line's figure came from. 'office': the office's own `lineTotal` (or its null, for an
   * AI-proposed line). 'preview' / 'mayComeDown': from the saved price sheet (U3). 'unpriced': no
   * figure; `priceReason` says why.
   */
  priceStatus: 'office' | PreviewLineStatus
  /** The words under the line when it is not the office's figure: the badge or the reason. */
  priceReason: string | null
}

export interface QuoteView extends Omit<QuoteState, 'lines'> {
  lines: QuoteViewLine[]
  /** True when any waiting edit is laid over the saved copy. */
  touched: boolean
  /**
   * 'server': every figure shown is the office's. 'none': no figure is shown that the office did
   * not send as it stands. 'preview': every figure shown comes from the saved price sheet
   * (shared/quotePreview), labelled Preview — untouched lines included, never mixed with the office's.
   */
  priceSource: 'server' | 'none' | 'preview'
  /** In preview mode: why the WHOLE quote shows no figure (rate provisional, supplier mismatch); else null. */
  previewReason: string | null
  /** In preview mode: each option holding lines, with its "may come down" / unpriced flags; else null. */
  previewOptions: PreviewOption[] | null
  /** In preview mode: when this phone saved the sheet the figures come from; else null. */
  priceSheetAt: string | null
  /** A discount change waiting to reach the office — words only; its dollars come from the office. Null when none waits. */
  pendingDiscount: { type: 'military' | 'senior' | 'custom' | null; percent: number | null } | null
  /** The edits laid over the copy, in order. */
  waiting: QuoteOpRecord[]
  refused: QuoteOpRecord[]
  /** True when the office has never received this quote. */
  localOnlyQuote: boolean
  /** When the saved copy was taken from the office; null for a phone-only quote. */
  snapshotAt: string | null
  pricesNeedReview: boolean
  /** The note of what this phone showed before the office's answer replaced it — "Check the prices" (U6) compares with it; null when none. */
  shownBeforeSync: ShownFigures | null
  pendingRebase: string | null
}

type CatalogLookup = ReadonlyMap<string, FieldCatalogRow> | ((itemId: string) => FieldCatalogRow | undefined)

/**
 * Pure. The display-only view: the office's last payload with the waiting edits laid over it.
 *
 * THE RULE (design §3, U4 trap): this function never adds, subtracts or multiplies a money
 * field. A line the tech touched (added, or quantity / difficulty / option / note / location
 * changed, or moved between options) shows `lineTotal: null, pendingPrice: true`; an untouched
 * line keeps exactly the figure the office sent. Once anything is laid over, every aggregate —
 * option subtotals, the total, the selection table, the discount's dollars, the range, financing
 * — is blank, because the office's aggregates no longer describe these lines and this phone
 * will not make new ones. Server figures and phone figures are never mixed in one total.
 *
 * WITH A SAVED PRICE SHEET (U3; Kyle, 2026-10-13: every line at its own difficulty): once anything is laid over, EVERY
 * figure — untouched lines included — comes from shared/quotePreview over the sheet, labelled
 * Preview (`priceSource: 'preview'`), and none of the office's figures survive into the view. One
 * price source at a time: the office's figures describe the lines the office had; the preview
 * describes the lines as they now stand; the two are never added together. This function still
 * does no arithmetic itself — the multiply and the sums are the shared preview's, the selection
 * table and the discount rows are the SAME shared builder the office's figures come from. An
 * AI-proposed line (not confirmed) is not previewed, exactly as the office does not price it.
 * Financing is never previewed. Nobody signs a preview: the firm number is set when the estimate
 * is issued with signal.
 *
 * Refused edits are NOT laid over (the office said no); they are listed in `refused` for the
 * banner. Delivered edits are laid over until the saved copy is refreshed from the office.
 */
export function overlayQuote(
  mirror: QuoteMirrorRecord | null | undefined,
  ops: readonly QuoteOpRecord[],
  catalog: CatalogLookup = new Map(),
  sheet: CachedPriceSheet | PhonePriceSheet | null = null,
): QuoteView {
  const lookup = typeof catalog === 'function' ? catalog : (id: string) => catalog.get(id)
  const ordered = [...ops].sort((a, b) => a.seq - b.seq)
  const start = ordered.find((o) => o.body.kind === 'start_quote')
  const draftId = mirror?.draftId ?? ordered[0]?.draftId ?? ''
  const base: QuoteState = mirror
    ? structuredClone(mirror.payload)
    : emptyQuoteState(draftId, start?.body.kind === 'start_quote' ? start.body.title : undefined)

  const lines: QuoteViewLine[] = base.lines.map((l) => ({
    ...l, pendingPrice: false, localOnly: false, pendingOpIds: [], priceStatus: 'office', priceReason: null,
  }))
  const optionEntries = base.optionSet.options.map((o) => ({ ...o }))
  let pendingDiscount: QuoteView['pendingDiscount'] = null
  let touched = false
  const waiting: QuoteOpRecord[] = []
  const refused: QuoteOpRecord[] = []

  const touchLine = (line: QuoteViewLine, opId: string) => {
    line.lineTotal = null
    line.pendingPrice = true
    line.priceStatus = 'unpriced'
    line.priceReason = PRICED_WHEN_SIGNAL_RETURNS
    line.pendingOpIds.push(opId)
  }

  for (const op of ordered) {
    if (op.status === 'refused') {
      refused.push(op)
      continue
    }
    const b = op.body
    switch (b.kind) {
      case 'start_quote':
        if (b.title && !mirror) base.title = b.title
        break
      case 'add_line': {
        const row = lookup(b.itemId)
        lines.push({
          id: b.lineId,
          itemId: b.itemId,
          description: row?.description ?? b.itemId,
          quantity: b.quantity,
          quantitySource: row?.isContinuousLength ? 'MEASURED_LENGTH' : 'COUNT',
          difficulty: b.difficulty ?? 'NORMAL',
          option: b.option ?? 'A',
          note: b.note ?? null,
          location: b.location ?? null,
          lineTotal: null,
          gaps: [],
          pendingPrice: true,
          localOnly: true,
          pendingOpIds: [op.opId],
          priceStatus: 'unpriced',
          priceReason: PRICED_WHEN_SIGNAL_RETURNS,
        })
        break
      }
      case 'edit_line': {
        const line = lines.find((l) => l.id === b.lineId)
        if (!line) break
        if (b.patch.quantity !== undefined) line.quantity = b.patch.quantity
        if (b.patch.difficulty !== undefined) line.difficulty = b.patch.difficulty
        if (b.patch.option !== undefined) line.option = b.patch.option
        if (b.patch.note !== undefined) line.note = b.patch.note
        if (b.patch.location !== undefined) line.location = b.patch.location
        if (b.patch.customName !== undefined) line.customName = b.patch.customName
        touchLine(line, op.opId)
        break
      }
      case 'remove_line': {
        const at = lines.findIndex((l) => l.id === b.lineId)
        if (at >= 0) lines.splice(at, 1)
        break
      }
      case 'add_option':
        if (!optionEntries.some((o) => o.option === b.option)) {
          optionEntries.push({ option: b.option, label: null, note: null, lineCount: 0, removable: true })
        }
        break
      case 'remove_option': {
        const at = optionEntries.findIndex((o) => o.option === b.option)
        if (at >= 0 && optionEntries[at].removable) optionEntries.splice(at, 1)
        for (let i = lines.length - 1; i >= 0; i -= 1) if (lines[i].option === b.option) lines.splice(i, 1)
        break
      }
      case 'set_option_meta': {
        const entry = optionEntries.find((o) => o.option === b.option)
        if (entry) {
          entry.label = b.label.trim() === '' ? null : b.label
          entry.note = b.note.trim() === '' ? null : b.note
        }
        break
      }
      case 'set_discount':
        pendingDiscount = { type: b.type, percent: b.type === 'custom' ? b.percent : null }
        break
      case 'set_mode':
        base.money.exclusiveOptions = b.exclusive
        break
      case 'set_details':
        if (b.title !== undefined) base.title = b.title
        if (b.jobDescription !== undefined) base.jobDescription = b.jobDescription
        break
      case 'line_order': {
        const byId = new Map(lines.map((l) => [l.id, l]))
        const reordered: QuoteViewLine[] = []
        for (const row of b.order) {
          const line = byId.get(row.lineId)
          if (!line) continue
          if (line.option !== row.option) {
            line.option = row.option
            touchLine(line, op.opId)
          }
          reordered.push(line)
          byId.delete(row.lineId)
        }
        // A line the order did not name (added since) keeps its place after the named ones.
        lines.splice(0, lines.length, ...reordered, ...byId.values())
        break
      }
    }
    waiting.push(op)
    touched = true
  }

  // Letters in order, counts from the lines as they now stand (words and counts, never money).
  optionEntries.sort((a, b) => a.option.localeCompare(b.option))
  for (const entry of optionEntries) entry.lineCount = lines.filter((l) => l.option === entry.option).length
  const optionSet = {
    options: optionEntries,
    nextOption: nextFreeOption(optionEntries.map((o) => o.option)),
    lockedReason: base.optionSet.lockedReason,
  }

  if (!touched) {
    return {
      ...base,
      lines,
      optionSet,
      touched: false,
      priceSource: 'server',
      previewReason: null,
      previewOptions: null,
      priceSheetAt: null,
      pendingDiscount: null,
      waiting,
      refused,
      localOnlyQuote: !mirror || mirror.origin === 'phone',
      snapshotAt: mirror?.origin === 'server' ? mirror.snapshotAt : null,
      pricesNeedReview: mirror?.pricesNeedReview ?? false,
      shownBeforeSync: mirror?.shownBeforeSync ?? null,
      pendingRebase: mirror?.pendingRebase ?? null,
    }
  }

  const tail = {
    touched: true as const,
    pendingDiscount,
    waiting,
    refused,
    localOnlyQuote: !mirror || mirror.origin === 'phone',
    snapshotAt: mirror?.origin === 'server' ? mirror.snapshotAt : null,
    pricesNeedReview: mirror?.pricesNeedReview ?? false,
    shownBeforeSync: mirror?.shownBeforeSync ?? null,
    pendingRebase: mirror?.pendingRebase ?? null,
  }
  const lifecycle = base.lifecycle.issued ? { ...base.lifecycle, hasUnsavedChanges: true } : base.lifecycle

  if (sheet) {
    // Something is laid over and the phone holds a price sheet: every figure is a PREVIEW from it.
    // The programme is the one waiting to reach the office if there is one, else the office's own
    // (words only — type and percent; the dollars are the shared builder's over the preview).
    const programme = pendingDiscount
      ? programmeFor(pendingDiscount.type, pendingDiscount.percent)
      : base.money.discount
        ? programmeFor(base.money.discount.type, base.money.discount.percent)
        : null
    const confirmed = lines.filter((l) => l.state !== 'PROPOSED')
    const preview = previewFigures(
      confirmed.map((l) => ({ id: l.id, itemId: l.itemId, quantity: l.quantity, difficulty: l.difficulty, option: l.option })),
      sheet,
      programme,
      { draftSupplierId: base.supplierId ?? null },
    )
    const previewed = new Map(preview.lines.map((p) => [p.id, p]))
    for (const line of lines) {
      const p = previewed.get(line.id)
      if (!p) continue // an AI proposal: the office did not price it and neither does the preview
      line.lineTotal = p.total
      line.pendingPrice = p.total === null
      line.priceStatus = p.status
      line.priceReason = p.reason
    }
    return {
      ...base,
      lines,
      optionSet,
      options: preview.options.map((o) => ({
        option: o.option as EstimateOptionLetter,
        lineCount: lines.filter((l) => l.option === o.option).length,
        subtotal: o.subtotal,
        complete: o.subtotal !== null,
      })),
      money: previewMoney(preview, base.money.exclusiveOptions, programme),
      total: previewTotal(preview),
      lifecycle,
      priceSource: 'preview',
      previewReason: preview.quoteReason,
      previewOptions: preview.options,
      priceSheetAt: 'cachedAt' in sheet ? sheet.cachedAt : sheet.generatedAt,
      ...tail,
    }
  }

  // Something is laid over and there is no price sheet: every aggregate is blank. The office's
  // subtotals, selections, discount dollars, range and financing described different lines; this
  // phone computes no replacement.
  const withLines = optionEntries.filter((o) => o.lineCount > 0).map((o) => o.option)
  const money: QuoteState['money'] = {
    exclusiveOptions: base.money.exclusiveOptions,
    range: null,
    discount: base.money.discount
      ? { ...base.money.discount, rows: [], pricedOnceComplete: true }
      : null,
    discountedTotal: null,
    discountedRange: null,
    pickable: withLines,
    selections: {},
    financing: null,
  }
  return {
    ...base,
    lines,
    optionSet,
    options: withLines.map((option) => ({
      option,
      lineCount: lines.filter((l) => l.option === option).length,
      subtotal: null,
      complete: false,
    })),
    money,
    total: null,
    lifecycle,
    priceSource: 'none',
    previewReason: null,
    previewOptions: null,
    priceSheetAt: null,
    ...tail,
  }
}

/** A quote that exists only on this phone so far: no lines, A/B/C, and NO figure anywhere. */
export function emptyQuoteState(draftId: string, title?: string): QuoteState {
  return {
    draftId,
    title: title ?? 'Quote',
    jobDescription: null,
    lifecycle: { status: 'draft', issued: null, hasUnsavedChanges: false, reviseReason: null, deleteReason: null, copyReason: null },
    suggestedLines: [],
    openQuestions: [],
    isChangeOrder: false,
    changeOrderFor: null,
    lines: [],
    optionSet: {
      options: BASE_OPTIONS.map((option) => ({ option, label: null, note: null, lineCount: 0, removable: false })),
      nextOption: nextFreeOption(BASE_OPTIONS),
      lockedReason: null,
    },
    options: [],
    money: {
      exclusiveOptions: false,
      range: null,
      discount: null,
      discountedTotal: null,
      discountedRange: null,
      pickable: [],
      selections: {},
      financing: null,
    },
    total: null,
    rateProvisional: false,
  }
}

/**
 * The view for one draft from what is on the phone: its saved copy, its queue, the saved price book
 * for any added item, and the saved price sheet (U3) — so a touched quote shows a labelled Preview
 * when the phone holds a sheet and "Priced when signal returns" when it does not.
 */
export async function loadQuoteView(draftId: string): Promise<QuoteView> {
  const [mirror, ops, sheet] = await Promise.all([db.quoteMirrors.get(draftId), quoteOpsForDraft(draftId), cachedPriceSheet()])
  const itemIds = ops.flatMap((o) => (o.body.kind === 'add_line' ? [o.body.itemId] : []))
  const catalog = await cachedCatalogRows(itemIds)
  return overlayQuote(mirror, ops, catalog, sheet)
}

/** The `expected` for a line edit, read off the line as the screen shows it — the fields the patch changes. */
export function expectedForLine(line: Pick<QuoteLine, 'quantity' | 'difficulty' | 'option' | 'note' | 'location'> & { customName?: string | null }, patch: QuoteLinePatch): QuoteLinePatch {
  const expected: QuoteLinePatch = {}
  if (patch.quantity !== undefined) expected.quantity = line.quantity
  if (patch.difficulty !== undefined) expected.difficulty = line.difficulty
  if (patch.option !== undefined) expected.option = line.option as EstimateOptionLetter
  if (patch.note !== undefined) expected.note = line.note
  if (patch.location !== undefined) expected.location = line.location
  if (patch.customName !== undefined) expected.customName = line.customName ?? null
  return expected
}

/**
 * The `expected` for each settings write, read off the quote AS THE SCREEN SHOWS IT (the view:
 * the office's copy with any waiting edit laid over, so a second change to the same setting names
 * the first as "what I saw" and replays after it). The discount's `percent` is compared with the
 * STORED percent, which the office keeps only for a custom programme — never the 5 a military or
 * senior row displays (withOfficeExpected has the same rule).
 */
export function expectedForDiscount(view: Pick<QuoteView, 'money' | 'pendingDiscount'>): NonNullable<Extract<QuoteOpBody, { kind: 'set_discount' }>['expected']> {
  const shown = view.pendingDiscount ?? (view.money.discount ? { type: view.money.discount.type, percent: view.money.discount.percent } : { type: null, percent: null })
  return { type: shown.type, percent: shown.type === 'custom' ? shown.percent : null }
}

export function expectedForMode(view: Pick<QuoteState, 'money'>): { exclusive: boolean } {
  return { exclusive: view.money.exclusiveOptions }
}

export function expectedForDetails(view: Pick<QuoteState, 'title' | 'jobDescription'>): { title: string | null; jobDescription: string | null } {
  return { title: view.title, jobDescription: view.jobDescription }
}

export function expectedForOptionMeta(view: Pick<QuoteState, 'optionSet'>, option: EstimateOptionLetter): { label: string | null; note: string | null } {
  const entry = view.optionSet.options.find((o) => o.option === option)
  return { label: entry?.label ?? null, note: entry?.note ?? null }
}
