/**
 * SIGNING WITH NO SIGNAL — the phone's half (Phase 7 unit U8, 2026-10-10, one-estimating-system
 * plan, design §6). Kyle, 2026-09-22: "They would have to be able to do estimates ... without
 * service." Kyle, 2026-10-09: ruling 9 (only an estimate issued with signal and unchanged since
 * can be signed with no signal) and ruling 10 (a signature inside the 30 days by the phone's clock
 * is honoured even when it reaches the office later; both times are kept).
 *
 * ── THE RULE ────────────────────────────────────────────────────────────────────────────────
 * A signature is a legal record, and the OFFICE records it. This phone never shows "Signed" until
 * the office has answered 2xx. What the phone does is keep the capture safe until then:
 *
 *  1. CAPTURE FIRST. "Accept & Sign" writes the signature to IndexedDB (the `signatureQueue`
 *     store) BEFORE anything is tried over the wire — the signer's name, the drawn mark, the
 *     options ticked, the revision, the server's own figures fingerprint, the consent sentence
 *     shown and the phone's clock, all in ONE row so the image can never come apart from its
 *     record. Online and offline alike (constants.md capture-first convention).
 *  2. SENT AT ONCE, through the SAME tech route the screen always used
 *     (crmSync.signEstimateInPerson -> POST /issued-estimates/:id/sign-in-person -> the office's
 *     own signInPerson/applySignature), carrying the id this phone minted. A 2xx is "Signed". No
 *     answer is "Signature saved on this phone — NOT recorded yet", and the row is sent again
 *     when signal returns, under the same id, so a lost answer lands on the one row the office
 *     already wrote (U7: the resend gets the original success, never "already signed").
 *  3. A REFUSAL (the office said no with words: revised, voided, lost, expired, another signer,
 *     the figures or the consent text changed) is never retried. The row turns red for the
 *     technician — "Not recorded: <reason>. The customer believes they signed — call them." —
 *     with "Sign again" and "I've called the customer — dismiss" (reason required). The office
 *     emailed Kyle when it refused (U7).
 *  4. THE EXITS. "Cancel this signature (not recorded yet)" (reason required) before it is
 *     recorded; the dismissal above after a refusal. Neither is deleted silently: each is filed as
 *     an event at the office on the next sync (POST /issued-estimates/:id/signature-events), and
 *     the row goes only once that is answered. If the office will NOT file it (the estimate is
 *     gone, or no longer this technician's) the row stays on the card as 'unfiled' with the
 *     office's words, and "Remove from this phone" is the exit (D4). Once recorded, voiding stays
 *     the office's (Q8).
 *
 * WHAT EACH SEND SAYS ABOUT ITSELF (D1, D2 — 2026-10-13): `sentAt`, this phone's clock at the
 * send, so the office judges the capture by how long it was held and not by this phone's date;
 * and `heldOnPhone`, true when the send is not the capture's own first try (taken with no signal,
 * or tried before with no answer) — the office emails Kyle only when it refuses one of THOSE,
 * because a refusal of a first try is on the screen in front of the customer.
 *
 * The gate (lib/signatureGate.ts) is applied at capture too: nothing is taken for an estimate
 * with edits waiting on this phone, past its 30 days by this clock, or with a signature already
 * held. Nothing here prices anything, and nothing here decides a signature is valid.
 *
 * crmSync must not import this module (main.tsx precedent): this module imports crmSync for the
 * calls and quoteSync for the storage ask and the waiting-edit count, and registers its own
 * `online` listener from main.tsx.
 */

import { db, type SignatureQueueRecord } from '../db/database'
import {
  CrmRequestError,
  fetchQuote,
  fileSignatureEvent,
  getCrmSettings,
  isNetworkFailure,
  signEstimateInPerson,
  type InPersonSignResult,
} from './crmSync'
import { pendingQuoteOpCount, requestPersistentStorage } from './quoteSync'
import { signGate } from './signatureGate'

export type { SignatureQueueRecord } from '../db/database'

// ─── Capture ─────────────────────────────────────────────────────────────────────────────────

export interface CaptureSignatureInput {
  estimateId: string
  /** The quote the estimate was issued from (for the waiting-edit gate and the refresh once signed); null when unknown. */
  draftId: string | null
  visitId: string | null
  /** The estimate's house number, for the cards. */
  number: string
  signerName: string
  /** The drawn mark, a data URL (400,000 characters at most — the server's limit). */
  signatureImage: string
  selectedOptions: string[]
  revision: number
  /** The server's own fingerprint of the figures shown (lifecycle.issued.figuresKey) — echoed, never computed here. */
  figuresKey: string
  /** The consent sentence the customer read, verbatim (shared/consentText CONSENT_TEXT). */
  consentText: string
  /** The validity window, for the gate: judged by this phone's clock at capture (ruling 10). */
  issuedAt: string
  validDays: number
}

export type SignatureOutcome =
  /** The office answered 2xx: Signed. `result` is the office's answer (the signed total is its figure). */
  | { state: 'recorded'; row: SignatureQueueRecord; result: InPersonSignResult }
  /** The office said no with words while the customer was still there; the row is gone and the words are for the screen. */
  | { state: 'refused'; reason: string }
  /** No answer (or sign in again): saved on this phone, NOT recorded yet. */
  | { state: 'queued'; row: SignatureQueueRecord; offline: boolean; reason?: string }

/**
 * "Accept & Sign": the gate, then the row, then the send. The row is on the phone before the
 * first byte goes out. Throws (with the gate's words) when nothing may be taken; otherwise
 * resolves with what became of it after one try.
 */
export async function captureSignature(input: CaptureSignatureInput): Promise<SignatureOutcome> {
  const held = await signatureForEstimate(input.estimateId)
  const waiting = input.draftId ? await pendingQuoteOpCount(input.draftId) : 0
  const gate = signGate({
    issued: { number: input.number, issuedAt: input.issuedAt, validDays: input.validDays, signedAt: null, status: 'sent' },
    hasUnsavedChanges: false,
    waiting,
    localOnlyQuote: false,
    // The 30 days are judged by this phone's clock at capture, signal or not (ruling 10).
    offline: true,
    signature: held ?? null,
  })
  if (gate.reason) throw new Error(gate.reason)
  if (input.signatureImage.length > 400_000) throw new Error('The drawn signature is too large to send — clear it and sign again, a little smaller.')

  const row: SignatureQueueRecord = {
    signatureId: crypto.randomUUID(),
    estimateId: input.estimateId,
    visitId: input.visitId,
    draftId: input.draftId,
    number: input.number,
    signerName: input.signerName,
    signatureImage: input.signatureImage,
    selectedOptions: [...input.selectedOptions],
    revision: input.revision,
    figuresKey: input.figuresKey,
    consentText: input.consentText,
    capturedAt: new Date().toISOString(),
    state: 'queued',
    attempts: 0,
    queuedAt: new Date().toISOString(),
    // Taken while the phone knew it had no signal: whatever send reaches the office is a send of
    // something HELD, and a refusal of it means the customer may already have left (D1).
    capturedOffline: phoneKnowsItIsOffline(),
  }
  await db.signatureQueue.add(row)
  // Something now exists on this phone and nowhere else: ask the browser not to evict it.
  void requestPersistentStorage()

  await flushSignatureQueue({ again: true })
  const after = await db.signatureQueue.get(row.signatureId)
  if (!after) throw new Error('The signature went missing from this phone while it was being sent — have the customer sign again.')
  if (after.state === 'recorded' && after.result) return { state: 'recorded', row: after, result: after.result }
  if (after.state === 'refused') {
    // Refused while the customer is still standing there: the words go to the screen that
    // pressed, exactly as before U8, and the row does not stay to make a red card for a refusal
    // the technician has already read. (The office emailed Kyle when it refused — U7.)
    await db.signatureQueue.delete(after.signatureId)
    return { state: 'refused', reason: after.reason ?? 'The office did not record the signature.' }
  }
  return {
    state: 'queued',
    row: after,
    offline: phoneKnowsItIsOffline() || lastPassHadNoAnswer,
    reason: signInNeeded ? 'Sign in again — the office no longer accepts this phone\'s sign-in' : after.lastError,
  }
}

// ─── Reading what is on the phone ────────────────────────────────────────────────────────────

/**
 * What the cards show: queued, refused, recorded — and 'unfiled' (D4), a cancellation the office
 * would not file, which stays in sight with the office's words until "Remove from this phone". A
 * plain 'cancelled' row is on its way to being filed and shows nowhere but the Today-screen count.
 */
const live = (r: SignatureQueueRecord) => r.state !== 'cancelled'
const newestFirst = (a: SignatureQueueRecord, b: SignatureQueueRecord) => b.queuedAt.localeCompare(a.queuedAt)

/** The signature this phone holds for one estimate — queued, refused, recorded or unfiled — or undefined. */
export async function signatureForEstimate(estimateId: string): Promise<SignatureQueueRecord | undefined> {
  const rows = await db.signatureQueue.where('estimateId').equals(estimateId).toArray()
  return rows.filter(live).sort(newestFirst)[0]
}

/** Every signature this phone holds on one visit (queued, refused, recorded or unfiled), newest first. */
export async function signaturesForVisit(visitId: string): Promise<SignatureQueueRecord[]> {
  return (await db.signatureQueue.toArray()).filter((r) => r.visitId === visitId && live(r)).sort(newestFirst)
}

/**
 * "N signatures saved on this phone — NOT recorded yet" on the Today screen: QUEUED captures only
 * (D5, 2026-10-13). A cancellation still to be filed is not a signature waiting to be recorded; it
 * is counted apart, by `pendingCancellationCount`.
 */
export async function pendingSignatureCount(): Promise<number> {
  return (await db.signatureQueue.toArray()).filter((r) => r.state === 'queued').length
}

/** Cancellations (and dismissals) still to be filed at the office — said separately on the Today screen (D5). */
export async function pendingCancellationCount(): Promise<number> {
  return (await db.signatureQueue.toArray()).filter((r) => r.state === 'cancelled').length
}

export function signatureById(signatureId: string): Promise<SignatureQueueRecord | undefined> {
  return db.signatureQueue.get(signatureId)
}

// ─── The exits ───────────────────────────────────────────────────────────────────────────────

/** The one row on the wire right now (sends are one at a time), or null. The exits refuse to touch it. */
let sendingId: string | null = null

function refuseIfInFlight(signatureId: string): void {
  if (signatureId === sendingId) throw new Error('That signature is being sent to the office right now — try again in a moment.')
}

/**
 * "Cancel this signature (not recorded yet)", reason required. Only a queued row (one the office
 * has not answered) can be cancelled; once recorded, voiding is the office's (CRM, Q8). The row
 * stays, marked cancelled, until the cancellation is filed as an event at the office.
 */
export async function cancelSignature(signatureId: string, reason: string): Promise<SignatureQueueRecord> {
  const why = reason.trim()
  if (!why) throw new Error('Say why the signature is being cancelled — the reason is filed at the office.')
  const row = await db.transaction('rw', db.signatureQueue, async () => {
    const r = await db.signatureQueue.get(signatureId)
    if (!r) throw new Error('That signature is no longer on this phone.')
    if (r.state === 'recorded') throw new Error(`Estimate ${r.number ?? r.estimateId} is signed and recorded at the office — a recorded signature is voided by the office, not here.`)
    if (r.state !== 'queued') throw new Error('Only a signature that has not been recorded yet can be cancelled.')
    refuseIfInFlight(signatureId)
    const next: SignatureQueueRecord = { ...r, state: 'cancelled', cancelKind: 'cancelled', cancelReason: why, cancelledAt: new Date().toISOString(), attempts: 0, lastError: undefined }
    await db.signatureQueue.put(next)
    return next
  })
  void flushSignatureQueue({ again: true })
  notifySettled()
  return row
}

/**
 * "I've called the customer — dismiss", reason required: a refused signature leaves the phone
 * once the dismissal (with the office's refusal words) is filed as an event at the office.
 */
export async function dismissRefusedSignature(signatureId: string, reason: string): Promise<SignatureQueueRecord> {
  const why = reason.trim()
  if (!why) throw new Error('Say what was done about it — the reason is filed at the office.')
  const row = await db.transaction('rw', db.signatureQueue, async () => {
    const r = await db.signatureQueue.get(signatureId)
    if (!r) throw new Error('That signature is no longer on this phone.')
    if (r.state !== 'refused') throw new Error('Only a signature the office refused can be dismissed.')
    refuseIfInFlight(signatureId)
    const next: SignatureQueueRecord = { ...r, state: 'cancelled', cancelKind: 'dismissed', cancelReason: why, cancelledAt: new Date().toISOString(), attempts: 0, lastError: undefined }
    await db.signatureQueue.put(next)
    return next
  })
  void flushSignatureQueue({ again: true })
  notifySettled()
  return row
}

/**
 * "Remove from this phone" (D4): the one exit for a cancellation the office refused to file. The
 * office has said, in words the technician has read on the card, that it will not take the event
 * (the estimate is gone, or no longer this technician's), so there is nowhere left for the row to
 * go; nothing was ever recorded for it. Only an 'unfiled' row can be removed this way.
 */
export async function removeUnfiledSignature(signatureId: string): Promise<void> {
  await db.transaction('rw', db.signatureQueue, async () => {
    const r = await db.signatureQueue.get(signatureId)
    if (!r) throw new Error('That signature is no longer on this phone.')
    if (r.state !== 'unfiled') throw new Error('Only a cancellation the office would not file can be removed here.')
    refuseIfInFlight(signatureId)
    await db.signatureQueue.delete(signatureId)
  })
  notifySettled()
}

/**
 * Recorded rows have done their job once the office's copy says signed (the Job site reads that
 * from the brief, the Quote screen from the lifecycle). Pruned at the Today-screen sync, so the
 * card has had its moment and a phone killed in the driveway still opens on "Signed".
 */
export async function pruneRecordedSignatures(): Promise<{ pruned: number }> {
  const gone = (await db.signatureQueue.toArray()).filter((r) => r.state === 'recorded').map((r) => r.signatureId)
  await db.signatureQueue.bulkDelete(gone)
  return { pruned: gone.length }
}

// ─── Flushing ────────────────────────────────────────────────────────────────────────────────

export interface SignatureFlushResult {
  recorded: number
  filed: number
  refused: number
  /** Queued captures and unfiled cancels left on the phone. */
  remaining: number
  /** A 401 stopped the pass: "Sign in again". */
  authNeeded: boolean
}

let flushInFlight: Promise<SignatureFlushResult> | null = null
let flushRerun = false
let signInNeeded = false
/** The last pass tried the office and got no answer at all (fetch threw). */
let lastPassHadNoAnswer = false

export function signatureSyncNeedsSignIn(): boolean {
  return signInNeeded
}

const settledListeners = new Set<() => void>()

/** Told after each pass (a row recorded, refused, filed, or a try that got no answer) and after an exit. */
export function onSignatureSyncSettled(listener: () => void): () => void {
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

function phoneKnowsItIsOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false
}

/*
  The same guard as quoteSync / diagnosticSync: one pass at a time; a request made because
  something changed (a capture, an exit, signal back) schedules exactly one more pass, and every
  caller waits for the whole chain — so a capture made mid-pass is still sent before its screen is
  told what became of it.
*/
export function flushSignatureQueue(opts: { again?: boolean } = {}): Promise<SignatureFlushResult> {
  if (flushInFlight) {
    if (opts.again) flushRerun = true
    return flushInFlight
  }
  const pass = (): Promise<SignatureFlushResult> =>
    runPass().then((result) => {
      notifySettled()
      if (!flushRerun) return result
      flushRerun = false
      return pass()
    })
  flushInFlight = pass().finally(() => {
    flushInFlight = null
    flushRerun = false
  })
  return flushInFlight
}

async function runPass(): Promise<SignatureFlushResult> {
  try {
    return await drain()
  } catch {
    // A DRAIN may fail; a CAPTURE may not. Every row is exactly where it was.
    return { recorded: 0, filed: 0, refused: 0, authNeeded: false, remaining: await remainingCount().catch(() => 0) }
  }
}

async function remainingCount(): Promise<number> {
  return (await db.signatureQueue.toArray()).filter((r) => r.state === 'queued' || r.state === 'cancelled').length
}

type Answer =
  | { kind: 'ok' }
  | { kind: 'transient' | 'auth'; message: string; network?: boolean; errorKind: 'network' | 'office' | 'phone' }
  | { kind: 'refused'; message: string }

/**
 * The answer table (design §5, as the quote queue reads it):
 *   2xx                        recorded (a capture) / filed and deleted (a cancel)
 *   network error, 5xx         keep, attempts+1 ("saved on this phone — NOT recorded yet")
 *   408 / 429                  keep, attempts+1 ("not now", not "no")
 *   401 / no session           keep ("Sign in again")
 *   400 / 403 / 404 / 409 / 422 (and a 200 carrying success: false)
 *                              a capture: REFUSED with the office's own words, never retried;
 *                              a cancel: the office will not file it (the estimate is gone or
 *                              no longer this technician's) — the row turns 'unfiled' and stays
 *                              on the card with those words until "Remove from this phone" (D4).
 *   anything else thrown       this phone's own code failed (D7): kept with the error on the card,
 *                              said as such — never "waiting for signal".
 */
function classify(error: unknown): Answer {
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof CrmRequestError) {
    const status = error.status
    if (status === 401) return { kind: 'auth', message, errorKind: 'office' }
    if (status === 408 || status === 429) return { kind: 'transient', message, errorKind: 'office' }
    if (status === undefined || (status >= 400 && status < 500)) return { kind: 'refused', message }
    return { kind: 'transient', message, errorKind: 'office' }
  }
  if (message === 'CRM not configured') return { kind: 'auth', message, errorKind: 'office' }
  const network = isNetworkFailure(error)
  return { kind: 'transient', message, network, errorKind: network ? 'network' : 'phone' }
}

async function drain(): Promise<SignatureFlushResult> {
  const result: SignatureFlushResult = { recorded: 0, filed: 0, refused: 0, remaining: 0, authNeeded: false }
  // No session, or the phone KNOWS it has no signal: nothing is attempted, nothing counts as a try.
  if (!getCrmSettings() || phoneKnowsItIsOffline()) {
    result.remaining = await remainingCount()
    return result
  }
  lastPassHadNoAnswer = false
  const rows = (await db.signatureQueue.toArray())
    .filter((r) => r.state === 'queued' || r.state === 'cancelled')
    .sort((a, b) => a.queuedAt.localeCompare(b.queuedAt))

  for (const stale of rows) {
    if (result.authNeeded) break
    // Re-read right before the send: the technician may have cancelled it meanwhile (an exit must
    // not reach the office as a signature), and sends are one at a time.
    const row = await db.signatureQueue.get(stale.signatureId)
    if (!row || row.state !== stale.state) continue
    sendingId = row.signatureId
    let answer: Answer
    let recorded: InPersonSignResult | null = null
    try {
      if (row.state === 'queued') {
        recorded = await signEstimateInPerson(row.estimateId, {
          signerName: row.signerName,
          signatureImage: row.signatureImage,
          selectedOptions: row.selectedOptions,
          clientSignatureId: row.signatureId,
          capturedAt: row.capturedAt,
          // This phone's clock NOW (D2): the office judges the capture by how long it was held, not by
          // this phone's idea of the date.
          sentAt: new Date().toISOString(),
          // Not the capture's own first try (D1): taken with no signal, or tried before with no
          // answer — a refusal now may reach a customer who has already left, so the office tells Kyle.
          heldOnPhone: row.capturedOffline === true || row.attempts > 0,
          revision: row.revision,
          figuresKey: row.figuresKey,
          consentText: row.consentText,
        })
      } else {
        await fileSignatureEvent(row.estimateId, {
          signatureId: row.signatureId,
          event: row.cancelKind ?? 'cancelled',
          reason: row.cancelReason ?? '',
          signerName: row.signerName,
          capturedAt: row.capturedAt,
          refusal: row.cancelKind === 'dismissed' ? row.reason : undefined,
        })
      }
      answer = { kind: 'ok' }
    } catch (error) {
      answer = classify(error)
    } finally {
      sendingId = null
    }

    if (answer.kind === 'ok') {
      if (row.state === 'queued') {
        await db.signatureQueue.update(row.signatureId, { state: 'recorded', result: recorded ?? undefined, recordedAt: new Date().toISOString(), lastError: undefined })
        result.recorded += 1
        // The office's copy now says signed (and locked): refresh it so the Quote screen reads so
        // with no further tap. Best effort — the signature is recorded whatever happens here.
        if (row.draftId) await fetchQuote(row.draftId, { visitId: row.visitId }).catch(() => undefined)
      } else {
        await db.signatureQueue.delete(row.signatureId)
        result.filed += 1
      }
      continue
    }
    if (answer.kind === 'refused') {
      if (row.state === 'queued') {
        await db.signatureQueue.update(row.signatureId, { state: 'refused', reason: answer.message, refusedAt: new Date().toISOString(), attempts: row.attempts + 1, lastError: answer.message })
        result.refused += 1
      } else {
        // The office will not file it (estimate gone, or no longer this technician's). Never retried
        // and never dropped silently (D4): the row stays, as 'unfiled', on the card with the office's
        // words, and the technician takes the one exit, "Remove from this phone".
        await db.signatureQueue.update(row.signatureId, { state: 'unfiled', fileRefusal: answer.message, attempts: row.attempts + 1, lastError: answer.message })
        result.refused += 1
      }
      continue
    }
    await db.signatureQueue.update(row.signatureId, { attempts: row.attempts + 1, lastError: answer.message, lastErrorKind: answer.errorKind })
    if (answer.kind === 'auth') result.authNeeded = true
    if (answer.network) {
      lastPassHadNoAnswer = true
      break // no signal: the rest would only fail the same way
    }
  }
  signInNeeded = result.authNeeded
  result.remaining = await remainingCount()
  return result
}

/** Re-flush whenever connectivity returns. Registered from main.tsx, beside the other queues' listeners. */
export function registerSignatureSyncListener(): void {
  window.addEventListener('online', () => {
    void flushSignatureQueue({ again: true })
  })
}
