/**
 * Signing with no signal — the phone's half (Phase 7 U8, 2026-10-10).
 *
 * What is proved, because it is what would cost a real signature if wrong:
 *
 *  1. CAPTURE FIRST, "SIGNED" ONLY ON A 2xx. The row (name, drawn mark, options, revision, figures
 *     key, consent sentence, the phone's clock) is in IndexedDB before any fetch, in ONE row; the
 *     send carries the id the phone minted; the row is 'queued' until the office answers 2xx and
 *     never 'recorded' before.
 *  2. THE ANSWER TABLE. No answer / 5xx / 408 / 429 keep it and count the try; 401 keeps it and says
 *     "sign in again"; a 4xx with words is REFUSED and never retried on its own; a refusal answered
 *     while the customer is still there goes back to the screen and leaves no card.
 *  3. THE GATE AT CAPTURE. A second signature while one waits, edits waiting on the draft, or past
 *     the 30 days by this clock: refused before anything is written.
 *  4. THE EXITS ARE FILED, NEVER SILENT. Cancel (reason required) and dismiss leave the phone only
 *     once the office has answered the event filing.
 */

import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { QuoteState } from './crmSync'

const BASE = 'https://rce.example.com/api/health-record'
const EST = 'est-1'
const D1 = '11111111-1111-4111-8111-111111111111'
const MARK = 'data:image/png;base64,iVBORw0KGgo='
const CONSENT = 'By typing my full name and tapping Accept & Sign, I agree.'
const KEY = 'a'.repeat(64)

function stubBrowser() {
  const store = new Map<string, string>([
    ['rce_crm_base_url', 'https://rce.example.com'],
    ['rce_crm_tech_token', 'tok'],
  ])
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  })
  vi.stubGlobal('window', {
    location: { hash: '', origin: 'https://rce.example.com', pathname: '/field/', search: '' },
    addEventListener: vi.fn(),
  })
  vi.stubGlobal('navigator', { onLine: true })
}

interface Call { method: string; path: string; body: unknown }
interface Answer { status: number; data?: unknown; error?: Record<string, unknown> }

function mockServer(handler: (call: Call) => Answer | Promise<Answer>) {
  const calls: Call[] = []
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const call: Call = { method: init?.method ?? 'GET', path: url.replace(BASE, ''), body: init?.body ? JSON.parse(String(init.body)) : null }
    calls.push(call)
    const answer = await handler(call)
    const ok = answer.status < 400
    return {
      ok,
      status: answer.status,
      json: () => Promise.resolve(ok ? { success: true, data: answer.data ?? {} } : { success: false, error: answer.error ?? { code: 'refused', message: `refused ${answer.status}` } }),
    }
  })
  vi.stubGlobal('fetch', fn)
  return { calls, fn }
}

function deadNetwork() {
  const fn = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
  vi.stubGlobal('fetch', fn)
  return fn
}

const SIGNED = { signed: true, estimateId: EST, number: '2026-1098', selectedOptions: ['A'], total: 950, jobVisitId: 'job-1', jobJoined: false, archivedNumbers: [] }
const signs = (c: Call) => c.method === 'POST' && c.path === `/issued-estimates/${EST}/sign-in-person`
const files = (c: Call) => c.method === 'POST' && c.path === `/issued-estimates/${EST}/signature-events`

function serverQuote(): QuoteState {
  return {
    draftId: D1,
    title: 'Hollis — 605 Green Farm Way',
    jobDescription: null,
    lifecycle: {
      status: 'finalized',
      issued: { estimateId: EST, number: '2026-1098', revision: 1, status: 'signed', signedAt: '2026-10-10T15:00:00.000Z', issuedAt: '2026-10-08T12:00:00.000Z', validDays: 30, figuresKey: KEY, archived: false, customerUrl: null },
      hasUnsavedChanges: false, reviseReason: 'signed', deleteReason: null, copyReason: null,
    },
    suggestedLines: [], openQuestions: [], isChangeOrder: false, changeOrderFor: null, lines: [],
    optionSet: { options: [], nextOption: 'B', lockedReason: 'signed' },
    options: [],
    money: { exclusiveOptions: false, range: null, discount: null, discountedTotal: null, discountedRange: null, pickable: [], selections: {}, financing: null },
    total: null,
    rateProvisional: false,
  }
}

let mod: typeof import('./signatureQueue')
let quoteSync: typeof import('./quoteSync')
let db: typeof import('../db/database').db

beforeEach(async () => {
  stubBrowser()
  vi.resetModules()
  mod = await import('./signatureQueue')
  quoteSync = await import('./quoteSync')
  db = (await import('../db/database')).db
  await Promise.all([db.signatureQueue.clear(), db.quoteOpQueue.clear(), db.quoteMirrors.clear(), db.meta.clear()])
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const capture = (over: Partial<Parameters<typeof mod.captureSignature>[0]> = {}) =>
  mod.captureSignature({
    estimateId: EST, draftId: D1, visitId: 'v1', number: '2026-1098',
    signerName: 'Mrs Panel', signatureImage: MARK, selectedOptions: ['A'],
    revision: 1, figuresKey: KEY, consentText: CONSENT,
    issuedAt: '2026-10-08T12:00:00.000Z', validDays: 30,
    ...over,
  })

/** Capture while the phone KNOWS it is offline: the row is written, nothing is tried. */
async function captureOffline(over: Partial<Parameters<typeof mod.captureSignature>[0]> = {}) {
  vi.stubGlobal('navigator', { onLine: false })
  try {
    return await capture(over)
  } finally {
    await mod.flushSignatureQueue()
    vi.stubGlobal('navigator', { onLine: true })
  }
}

describe('capture first, "Signed" only on the office\'s 2xx', () => {
  it('with no answer: the whole capture is in ONE row before the try, the try carried the phone\'s id and the capture fields, and the outcome is "saved — not recorded"', async () => {
    const fetchMock = deadNetwork()
    const storage = { persisted: vi.fn().mockResolvedValue(false), persist: vi.fn().mockResolvedValue(true) }
    vi.stubGlobal('navigator', { onLine: true, storage })
    const before = Date.now()
    const outcome = await capture()
    expect(outcome.state).toBe('queued')
    if (outcome.state !== 'queued') throw new Error('unreachable')
    expect(outcome.offline).toBe(true)

    const rows = await db.signatureQueue.toArray()
    expect(rows).toHaveLength(1)
    const row = rows[0]
    expect(row).toMatchObject({ estimateId: EST, draftId: D1, visitId: 'v1', number: '2026-1098', signerName: 'Mrs Panel', signatureImage: MARK, selectedOptions: ['A'], revision: 1, figuresKey: KEY, consentText: CONSENT, state: 'queued', attempts: 1 })
    expect(Date.parse(row.capturedAt)).toBeGreaterThanOrEqual(before)
    expect(row.result).toBeUndefined()
    expect(row.recordedAt).toBeUndefined()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${BASE}/issued-estimates/${EST}/sign-in-person`)
    const body = JSON.parse(String(init.body))
    expect(body).toEqual({
      signerName: 'Mrs Panel', signatureImage: MARK, selectedOptions: ['A'],
      clientSignatureId: row.signatureId, capturedAt: row.capturedAt, revision: 1, figuresKey: KEY, consentText: CONSENT,
      // D2: this phone's clock at the send; D1: the capture's own first try, so NOT held.
      sentAt: expect.any(String), heldOnPhone: false,
    })
    expect(Date.parse(body.sentAt)).toBeGreaterThanOrEqual(Date.parse(row.capturedAt))
    expect(row.capturedOffline).toBe(false)
    expect(row.lastErrorKind).toBe('network')
    expect(row.signatureId).toMatch(/^[0-9a-f-]{36}$/)
    // Something exists on this phone and nowhere else: the browser was asked to keep it.
    await vi.waitFor(() => expect(storage.persist).toHaveBeenCalledTimes(1))
    expect(await mod.pendingSignatureCount()).toBe(1)
  })

  it('the phone KNOWS it is offline: the row is written and nothing is tried; the first send that does go out says it was held (D1)', async () => {
    const fetchMock = deadNetwork()
    const outcome = await captureOffline()
    expect(outcome.state).toBe('queued')
    expect(fetchMock).not.toHaveBeenCalled()
    const row = (await db.signatureQueue.toArray())[0]
    expect(row.attempts).toBe(0)
    expect(row.capturedOffline).toBe(true)
    // Signal back: attempts is still 0 (nothing was tried), but the capture was taken with no signal,
    // so the send is marked held — the customer may be gone by the time the office answers.
    const { calls } = mockServer((c) => (signs(c) ? { status: 201, data: SIGNED } : { status: 404 }))
    await mod.flushSignatureQueue()
    expect(calls.filter(signs)[0].body).toMatchObject({ heldOnPhone: true })
  })

  it('a refusal of the capture\'s own first try is NOT marked held (the customer is standing there): the office emails nobody (D1)', async () => {
    const { calls } = mockServer((c) => (signs(c) ? { status: 400, error: { code: 'not_signed', message: 'This estimate is void.' } } : { status: 404 }))
    const outcome = await capture()
    expect(outcome).toEqual({ state: 'refused', reason: 'This estimate is void.' })
    expect(calls.filter(signs)[0].body).toMatchObject({ heldOnPhone: false })
  })

  it('signal back: sent again under the SAME id, recorded on the office\'s 2xx with its answer kept on the row, and the quote\'s saved copy refreshed to the signed lifecycle', async () => {
    deadNetwork()
    const outcome = await capture()
    const id = outcome.state === 'queued' ? outcome.row.signatureId : ''
    await db.quoteMirrors.put({ draftId: D1, visitId: 'v1', payload: { ...serverQuote(), lifecycle: { ...serverQuote().lifecycle, issued: { ...serverQuote().lifecycle.issued!, status: 'sent', signedAt: null } } }, snapshotAt: '2026-10-10T14:00:00.000Z', origin: 'server', pricesNeedReview: false, pendingRebase: null })

    const { calls } = mockServer((c) => {
      if (signs(c)) return { status: 201, data: SIGNED }
      if (c.path === `/quotes/${D1}`) return { status: 200, data: serverQuote() }
      return { status: 404 }
    })
    const settled = vi.fn()
    mod.onSignatureSyncSettled(settled)
    const result = await mod.flushSignatureQueue()
    expect(result).toMatchObject({ recorded: 1, refused: 0, filed: 0, remaining: 0, authNeeded: false })
    const sent = calls.filter(signs)
    expect(sent).toHaveLength(1)
    expect((sent[0].body as { clientSignatureId: string }).clientSignatureId).toBe(id)
    // D1: this send is a RESEND of something held (the first try got no answer) — a refusal of it
    // would be one the customer is not there to see, and the office tells Kyle. D2: a fresh send time.
    expect(sent[0].body).toMatchObject({ heldOnPhone: true, sentAt: expect.any(String) })

    const row = (await db.signatureQueue.get(id))!
    expect(row.state).toBe('recorded')
    expect(row.result).toEqual(SIGNED)
    expect(row.recordedAt).toBeTruthy()
    expect(settled).toHaveBeenCalled()
    expect((await mod.signatureForEstimate(EST))?.state).toBe('recorded')
    // The office's copy says signed now, without a further tap.
    expect((await db.quoteMirrors.get(D1))?.payload.lifecycle.issued?.signedAt).toBe('2026-10-10T15:00:00.000Z')
    // Recorded rows are pruned at the Today-screen sync; queued ones never are.
    expect(await mod.pruneRecordedSignatures()).toEqual({ pruned: 1 })
    expect(await db.signatureQueue.count()).toBe(0)
  })

  it('with signal: recorded at once, and the screen is handed the office\'s answer', async () => {
    mockServer((c) => (signs(c) ? { status: 201, data: SIGNED } : { status: 404 }))
    const outcome = await capture()
    expect(outcome.state).toBe('recorded')
    if (outcome.state !== 'recorded') throw new Error('unreachable')
    expect(outcome.result).toEqual(SIGNED)
    expect(outcome.row.state).toBe('recorded')
  })

  it('a refusal answered while the customer is still there goes back to the screen in the office\'s words, and leaves no card', async () => {
    const { calls } = mockServer((c) => (signs(c) ? { status: 400, error: { code: 'not_signed', message: 'This estimate has already been signed.' } } : { status: 404 }))
    const outcome = await capture()
    expect(outcome).toEqual({ state: 'refused', reason: 'This estimate has already been signed.' })
    expect(await db.signatureQueue.count()).toBe(0)
    expect(calls.filter(signs)).toHaveLength(1)
  })
})

describe('the answer table for a queued signature', () => {
  it('a 5xx, a 408 and a 429 keep it (attempts+1); the next flush delivers it', async () => {
    await captureOffline()
    for (const status of [503, 408, 429]) {
      mockServer((c) => (signs(c) ? { status } : { status: 404 }))
      const r = await mod.flushSignatureQueue()
      expect(r.recorded).toBe(0)
      expect((await db.signatureQueue.toArray())[0].state).toBe('queued')
    }
    expect((await db.signatureQueue.toArray())[0].attempts).toBe(3)
    mockServer((c) => (signs(c) ? { status: 201, data: SIGNED } : { status: 404 }))
    expect((await mod.flushSignatureQueue()).recorded).toBe(1)
  })

  it('a 401 keeps it untouched and says "sign in again"; the next answered pass clears that', async () => {
    await captureOffline()
    mockServer((c) => (signs(c) ? { status: 401, error: { code: 'unauthorized', message: 'Invalid token' } } : { status: 404 }))
    const r = await mod.flushSignatureQueue()
    expect(r.authNeeded).toBe(true)
    expect(mod.signatureSyncNeedsSignIn()).toBe(true)
    expect((await db.signatureQueue.toArray())[0].state).toBe('queued')
    mockServer((c) => (signs(c) ? { status: 201, data: SIGNED } : { status: 404 }))
    await mod.flushSignatureQueue()
    expect(mod.signatureSyncNeedsSignIn()).toBe(false)
  })

  it('a refusal on a later pass (the estimate was voided meanwhile): REFUSED with the office\'s words, never retried on its own, and still on the phone for the red card', async () => {
    await captureOffline()
    const { calls } = mockServer((c) => (signs(c) ? { status: 400, error: { code: 'not_signed', message: 'This estimate is void.' } } : { status: 404 }))
    const r = await mod.flushSignatureQueue()
    expect(r.refused).toBe(1)
    const row = (await db.signatureQueue.toArray())[0]
    expect(row.state).toBe('refused')
    expect(row.reason).toBe('This estimate is void.')
    expect(row.refusedAt).toBeTruthy()
    expect(row.signatureImage).toBe(MARK)
    await mod.flushSignatureQueue()
    await mod.flushSignatureQueue()
    expect(calls.filter(signs)).toHaveLength(1)
    expect((await mod.signatureForEstimate(EST))?.state).toBe('refused')
    // A refused row is not "waiting for signal".
    expect(await mod.pendingSignatureCount()).toBe(0)
  })

  it('a 403 (reassigned) and a 404 (deleted) are refusals too, with the words; a 200 carrying success:false as well', async () => {
    for (const answer of [
      { status: 403, error: { code: 'forbidden', message: 'This estimate is not on one of your visits' } },
      { status: 404, error: { code: 'not_found', message: 'Estimate not found' } },
    ]) {
      await db.signatureQueue.clear()
      await captureOffline()
      mockServer((c) => (signs(c) ? answer : { status: 404 }))
      await mod.flushSignatureQueue()
      const row = (await db.signatureQueue.toArray())[0]
      expect(row.state).toBe('refused')
      expect(row.reason).toBe(answer.error.message)
    }
  })

  it('no answer mid-pass stops the pass (the rest would fail the same way) and the rows keep their order on the next one', async () => {
    await captureOffline()
    await captureOffline({ estimateId: 'est-2', number: '2026-1099' })
    const fetchMock = deadNetwork()
    await mod.flushSignatureQueue()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const { calls } = mockServer((c) => (c.method === 'POST' && c.path.endsWith('/sign-in-person') ? { status: 201, data: SIGNED } : { status: 404 }))
    await mod.flushSignatureQueue()
    expect(calls.filter((c) => c.path.endsWith('/sign-in-person')).map((c) => c.path)).toEqual([`/issued-estimates/${EST}/sign-in-person`, '/issued-estimates/est-2/sign-in-person'])
  })
})

describe('the gate at capture: nothing is written that the office is already known to refuse', () => {
  it('a second signature while one is saved on this phone', async () => {
    deadNetwork()
    await capture()
    await expect(capture({ signerName: 'Mr Panel' })).rejects.toThrow(/already saved on this phone/)
    expect(await db.signatureQueue.count()).toBe(1)
  })

  it('edits waiting on the draft: "You changed this estimate on the phone"', async () => {
    deadNetwork()
    vi.stubGlobal('navigator', { onLine: false })
    await quoteSync.enqueueQuoteOp({ draftId: D1, visitId: 'v1', body: { kind: 'set_details', title: 'Changed on the phone' } })
    await quoteSync.flushQuoteQueue()
    await expect(capture()).rejects.toThrow(/You changed this estimate on the phone/)
    expect(await db.signatureQueue.count()).toBe(0)
  })

  it('past the 30 days by this phone\'s clock: expired, nothing written', async () => {
    deadNetwork()
    await expect(capture({ issuedAt: new Date(Date.now() - 31 * 86_400_000).toISOString() })).rejects.toThrow(/expired on/)
    expect(await db.signatureQueue.count()).toBe(0)
  })

  it('a drawn mark over the server\'s 400,000-character limit is refused before the row is written', async () => {
    deadNetwork()
    await expect(capture({ signatureImage: 'x'.repeat(400_001) })).rejects.toThrow(/too large/)
    expect(await db.signatureQueue.count()).toBe(0)
  })
})

describe('the exits are filed at the office, never silent', () => {
  it('"Cancel this signature (not recorded yet)": reason required; the row waits as cancelled, is FILED as an event on the next pass (id, reason, signer, the phone\'s clock) and only then goes', async () => {
    deadNetwork()
    const outcome = await capture()
    const id = outcome.state === 'queued' ? outcome.row.signatureId : ''
    await expect(mod.cancelSignature(id, '   ')).rejects.toThrow(/reason/)
    expect((await db.signatureQueue.get(id))?.state).toBe('queued')

    vi.stubGlobal('navigator', { onLine: false })
    const row = await mod.cancelSignature(id, 'Customer wants to think it over')
    await mod.flushSignatureQueue()
    expect(row.state).toBe('cancelled')
    expect(row.cancelKind).toBe('cancelled')
    expect((await db.signatureQueue.get(id))).toMatchObject({ state: 'cancelled', cancelReason: 'Customer wants to think it over', signatureImage: MARK })
    expect(await mod.signatureForEstimate(EST)).toBeUndefined()
    // D5: a cancellation on its way to being filed is not a signature "NOT recorded yet"; it is counted apart.
    expect(await mod.pendingSignatureCount()).toBe(0)
    expect(await mod.pendingCancellationCount()).toBe(1)

    vi.stubGlobal('navigator', { onLine: true })
    const { calls } = mockServer((c) => (files(c) ? { status: 200, data: { filed: true, duplicate: false } } : { status: 404 }))
    const r = await mod.flushSignatureQueue()
    expect(r.filed).toBe(1)
    const filed = calls.filter(files)
    expect(filed).toHaveLength(1)
    expect(filed[0].body).toEqual({ signatureId: id, event: 'cancelled', reason: 'Customer wants to think it over', signerName: 'Mrs Panel', capturedAt: row.capturedAt })
    expect(calls.filter(signs)).toHaveLength(0)
    expect(await db.signatureQueue.count()).toBe(0)
    expect(await mod.pendingCancellationCount()).toBe(0)
  })

  it('a recorded signature cannot be cancelled here (voiding is the office\'s); a refused one cannot be cancelled, only dismissed', async () => {
    mockServer((c) => (signs(c) ? { status: 201, data: SIGNED } : { status: 404 }))
    const recorded = await capture()
    const id = recorded.state === 'recorded' ? recorded.row.signatureId : ''
    await expect(mod.cancelSignature(id, 'oops')).rejects.toThrow(/voided by the office/)
    await expect(mod.dismissRefusedSignature(id, 'oops')).rejects.toThrow(/Only a signature the office refused/)
    expect((await db.signatureQueue.get(id))?.state).toBe('recorded')
  })

  it('"I\'ve called the customer — dismiss": a refused row is filed with the office\'s refusal and the technician\'s reason, then goes; a lost answer files it again under the same id', async () => {
    await captureOffline()
    mockServer((c) => (signs(c) ? { status: 400, error: { code: 'not_signed', message: 'This estimate is void.' } } : { status: 404 }))
    await mod.flushSignatureQueue()
    const id = (await db.signatureQueue.toArray())[0].signatureId
    await expect(mod.cancelSignature(id, 'x')).rejects.toThrow(/Only a signature that has not been recorded yet/)

    deadNetwork()
    await mod.dismissRefusedSignature(id, 'Called Mrs Panel — she will sign the reissued one')
    await mod.flushSignatureQueue()
    expect((await db.signatureQueue.get(id))?.state).toBe('cancelled')

    const { calls } = mockServer((c) => (files(c) ? { status: 200, data: { filed: true, duplicate: true } } : { status: 404 }))
    await mod.flushSignatureQueue()
    expect(calls.filter(files)[0].body).toMatchObject({ signatureId: id, event: 'dismissed', reason: 'Called Mrs Panel — she will sign the reissued one', refusal: 'This estimate is void.' })
    expect(await db.signatureQueue.count()).toBe(0)
  })

  it('a cancel the office will not file (the estimate is gone, 404) is neither retried nor dropped: the row stays UNFILED with the office\'s words, on the card, until "Remove from this phone" (D4)', async () => {
    deadNetwork()
    const outcome = await capture()
    const id = outcome.state === 'queued' ? outcome.row.signatureId : ''
    vi.stubGlobal('navigator', { onLine: false })
    await mod.cancelSignature(id, 'gone')
    await mod.flushSignatureQueue()
    vi.stubGlobal('navigator', { onLine: true })
    const { calls } = mockServer((c) => (files(c) ? { status: 404, error: { code: 'not_found', message: 'Estimate not found' } } : { status: 404 }))
    const r = await mod.flushSignatureQueue()
    expect(r.refused).toBe(1)
    const row = (await db.signatureQueue.get(id))!
    expect(row).toMatchObject({ state: 'unfiled', cancelKind: 'cancelled', cancelReason: 'gone', fileRefusal: 'Estimate not found' })
    // Never retried on its own.
    await mod.flushSignatureQueue()
    await mod.flushSignatureQueue()
    expect(calls.filter(files)).toHaveLength(1)
    // On the card (the job and the quote read these), but not held for the gate and not in either Today count.
    expect((await mod.signaturesForVisit('v1')).map((s) => s.state)).toEqual(['unfiled'])
    expect((await mod.signatureForEstimate(EST))?.state).toBe('unfiled')
    expect(await mod.pendingSignatureCount()).toBe(0)
    expect(await mod.pendingCancellationCount()).toBe(0)
    expect(r.remaining).toBe(0)
    // Not a signature any more: a new one can be taken for the same estimate.
    deadNetwork()
    await expect(capture()).resolves.toMatchObject({ state: 'queued' })
    // The other exits refuse it; the one exit removes it, and only it.
    await expect(mod.cancelSignature(id, 'x')).rejects.toThrow(/Only a signature that has not been recorded yet/)
    await expect(mod.dismissRefusedSignature(id, 'x')).rejects.toThrow(/Only a signature the office refused/)
    const queuedId = (await db.signatureQueue.toArray()).find((s) => s.state === 'queued')!.signatureId
    await expect(mod.removeUnfiledSignature(queuedId)).rejects.toThrow(/Only a cancellation the office would not file/)
    await mod.removeUnfiledSignature(id)
    expect(await db.signatureQueue.get(id)).toBeUndefined()
    expect(await db.signatureQueue.count()).toBe(1)
  })

  it('a dismissal the office will not file ends the same way, keeping the office\'s refusal AND why it would not file', async () => {
    await captureOffline()
    mockServer((c) => (signs(c) ? { status: 400, error: { code: 'not_signed', message: 'This estimate is void.' } } : { status: 404 }))
    await mod.flushSignatureQueue()
    const id = (await db.signatureQueue.toArray())[0].signatureId
    vi.stubGlobal('navigator', { onLine: false })
    await mod.dismissRefusedSignature(id, 'Called her')
    await mod.flushSignatureQueue()
    vi.stubGlobal('navigator', { onLine: true })
    mockServer((c) => (files(c) ? { status: 403, error: { code: 'forbidden', message: 'This estimate is not on one of your visits' } } : { status: 404 }))
    await mod.flushSignatureQueue()
    expect(await db.signatureQueue.get(id)).toMatchObject({ state: 'unfiled', cancelKind: 'dismissed', reason: 'This estimate is void.', cancelReason: 'Called her', fileRefusal: 'This estimate is not on one of your visits' })
  })

  it('this phone\'s own code failing on a send is not "waiting for signal" (D7): kept, with the error said as the phone\'s', async () => {
    await captureOffline()
    // The settings read inside the request throws a TypeError that is NOT fetch's: a bug, not a dead network.
    const store = new Map<string, string>([['rce_crm_base_url', 'https://rce.example.com'], ['rce_crm_tech_token', 'tok']])
    let reads = 0
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => {
        reads += 1
        if (reads > 2) throw new TypeError("Cannot read properties of undefined (reading 'token')")
        return store.get(k) ?? null
      },
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    })
    const fetchMock = deadNetwork()
    await mod.flushSignatureQueue()
    expect(fetchMock).not.toHaveBeenCalled()
    const row = (await db.signatureQueue.toArray())[0]
    expect(row).toMatchObject({ state: 'queued', attempts: 1, lastErrorKind: 'phone' })
    expect(row.lastError).toMatch(/Cannot read properties/)
  })

  it('an exit cannot touch the row on the wire', async () => {
    await captureOffline()
    const id = (await db.signatureQueue.toArray())[0].signatureId
    let release!: () => void
    const held = new Promise<void>((r) => { release = r })
    vi.stubGlobal('fetch', vi.fn(async () => {
      await held
      return { ok: true, status: 201, json: () => Promise.resolve({ success: true, data: SIGNED }) }
    }))
    const flush = mod.flushSignatureQueue()
    await new Promise((r) => setTimeout(r, 10))
    await expect(mod.cancelSignature(id, 'too late')).rejects.toThrow(/being sent to the office right now/)
    release()
    await flush
    expect((await db.signatureQueue.get(id))?.state).toBe('recorded')
  })
})

describe('reading what is on the phone', () => {
  it('signaturesForVisit lists the visit\'s live rows newest first and leaves cancelled ones out; signatureForEstimate finds by estimate', async () => {
    await captureOffline()
    await captureOffline({ estimateId: 'est-2', number: '2026-1099', visitId: 'v2' })
    await captureOffline({ estimateId: 'est-3', number: '2026-1100' })
    const v1 = await mod.signaturesForVisit('v1')
    expect(v1.map((r) => r.estimateId)).toEqual(['est-3', EST])
    expect((await mod.signaturesForVisit('v2')).map((r) => r.estimateId)).toEqual(['est-2'])
    vi.stubGlobal('navigator', { onLine: false })
    await mod.cancelSignature(v1[0].signatureId, 'no')
    await mod.flushSignatureQueue()
    expect((await mod.signaturesForVisit('v1')).map((r) => r.estimateId)).toEqual([EST])
    expect((await mod.signatureForEstimate('est-3'))).toBeUndefined()
    expect((await mod.signatureById(v1[1].signatureId))?.estimateId).toBe(EST)
  })

  it('registerSignatureSyncListener re-flushes on the browser online event; a settled listener stops after unsubscribe', async () => {
    mod.registerSignatureSyncListener()
    expect((window.addEventListener as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('online')
    const settled = vi.fn()
    const off = mod.onSignatureSyncSettled(settled)
    await mod.flushSignatureQueue()
    expect(settled).toHaveBeenCalledTimes(1)
    off()
    await mod.flushSignatureQueue()
    expect(settled).toHaveBeenCalledTimes(1)
  })
})
