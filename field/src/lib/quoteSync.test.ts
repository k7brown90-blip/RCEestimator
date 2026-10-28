/**
 * Estimating with no signal — the phone's queue, flush and overlay (Phase 7 U4, 2026-10-09).
 *
 * Two things are being proved, the two that would cost real money if wrong:
 *
 *  1. DURABILITY AND ORDER. An edit is on the phone before anything is tried over the wire; it
 *     replays in order through the SAME tech routes the online phone uses, carrying the id the
 *     phone minted and `expected`; a refusal stops only that draft; nothing is deleted except
 *     after a 2xx, a 404 on a remove, or an explicit Discard.
 *  2. NO INVENTED FIGURES. The overlay never shows a number the office did not send for the
 *     lines as they now stand. A touched line reads "priced when signal returns"; every
 *     aggregate goes blank the moment anything is laid over.
 */

import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { QuoteState } from './crmSync'
import type { QuoteMirrorRecord, QuoteOpRecord } from '../db/database'

const BASE = 'https://rce.example.com/api/health-record'
const D1 = '11111111-1111-4111-8111-111111111111'
const D2 = '22222222-2222-4222-8222-222222222222'
const L1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const L2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

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
}

interface Call { method: string; path: string; body: unknown }
interface Answer { status: number; data?: unknown; error?: Record<string, unknown> }

/** A routed fake server: the handler decides each answer; every call is recorded in order. */
function mockServer(handler: (call: Call) => Answer | Promise<Answer>) {
  const calls: Call[] = []
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? 'GET',
      path: url.replace(BASE, ''),
      body: init?.body ? JSON.parse(String(init.body)) : null,
    }
    calls.push(call)
    const answer = await handler(call)
    const ok = answer.status < 400
    return {
      ok,
      status: answer.status,
      json: () => Promise.resolve(ok
        ? { success: true, data: answer.data ?? {} }
        : { success: false, error: answer.error ?? { code: 'refused', message: `refused ${answer.status}` } }),
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

/** What the office sends for a priced two-line quote — the only numbers that may ever appear. */
function serverQuote(draftId = D1): QuoteState {
  return {
    draftId,
    supplierId: 'HD',
    title: 'Hollis — 605 Green Farm Way',
    jobDescription: 'Replace the panel.',
    lifecycle: { status: 'draft', issued: null, hasUnsavedChanges: false, reviseReason: null, deleteReason: null, copyReason: null },
    suggestedLines: [],
    openQuestions: [],
    isChangeOrder: false,
    changeOrderFor: null,
    lines: [
      { id: 'line-1', itemId: 'A016', description: 'Single-pole switch', quantity: 2, quantitySource: 'COUNT', difficulty: 'NORMAL', option: 'A', note: null, location: null, lineTotal: 120.5, gaps: [], retired: false },
      { id: 'line-2', itemId: 'B002', description: 'Duplex receptacle', quantity: 1, quantitySource: 'COUNT', difficulty: 'NORMAL', option: 'A', note: 'left wall', location: 'Garage', lineTotal: 80, gaps: [], retired: false },
    ],
    optionSet: {
      options: [
        { option: 'A', label: null, note: null, lineCount: 2, removable: false },
        { option: 'B', label: null, note: null, lineCount: 0, removable: false },
        { option: 'C', label: null, note: null, lineCount: 0, removable: false },
      ],
      nextOption: 'D',
      lockedReason: null,
    },
    options: [{ option: 'A', lineCount: 2, subtotal: 200.5, complete: true }],
    money: {
      exclusiveOptions: false,
      range: null,
      discount: { type: 'military', percent: 5, label: 'Military discount (5%)', terms: '5% off, capped at $250', rows: [{ label: 'whole job', base: 200.5, comboSaving: 0, amount: 10.03, capped: false, after: 190.47 }], pricedOnceComplete: false },
      discountedTotal: 190.47,
      discountedRange: null,
      pickable: ['A'],
      selections: { A: { key: 'A', options: ['A'], subtotal: 200.5, trip: 0, comboSaving: 0, base: 200.5, discount: 10.03, discountCapped: false, total: 190.47 } },
      financing: null,
    },
    total: 200.5,
    rateProvisional: false,
  }
}

function mirrorOf(payload: QuoteState, extra: Partial<QuoteMirrorRecord> = {}): QuoteMirrorRecord {
  return { draftId: payload.draftId, visitId: 'v1', payload, snapshotAt: '2026-10-09T14:14:00.000Z', origin: 'server', pricesNeedReview: false, pendingRebase: null, ...extra }
}

/** Every number anywhere inside a value — so a view can be checked against what the office sent. */
function numbersIn(value: unknown, out = new Set<number>()): Set<number> {
  if (typeof value === 'number') out.add(value)
  else if (Array.isArray(value)) value.forEach((v) => numbersIn(v, out))
  else if (value && typeof value === 'object') Object.values(value).forEach((v) => numbersIn(v, out))
  return out
}

const CATALOG = {
  version: 'v1',
  generatedAt: '2026-10-09T13:00:00.000Z',
  rows: [
    { itemId: 'B002', description: 'Duplex receptacle', category: 'Devices', unit: 'ea', isAssembly: false, hasLabourUnitBasis: true, hasPriceAtActiveSupplier: true, isFlatPriced: false, isContinuousLength: false, hasPublishedLabour: true, sellsMaterial: true, isHourlyProduct: false },
    { itemId: 'A016', description: 'Single-pole switch', category: 'Devices', unit: 'ea', isAssembly: false, hasLabourUnitBasis: true, hasPriceAtActiveSupplier: true, isFlatPriced: false, isContinuousLength: false, hasPublishedLabour: true, sellsMaterial: true, isHourlyProduct: false },
    { itemId: 'W142', description: '14/2 NM-B', category: 'Wire', unit: 'ft', isAssembly: false, hasLabourUnitBasis: true, hasPriceAtActiveSupplier: true, isFlatPriced: false, isContinuousLength: true, hasPublishedLabour: true, sellsMaterial: true, isHourlyProduct: false },
  ],
  sections: [{ section: 'Devices', itemCount: 2 }, { section: 'Wire', itemCount: 1 }],
}

let mod: typeof import('./quoteSync')
let crmSync: typeof import('./crmSync')
let db: typeof import('../db/database').db

beforeEach(async () => {
  stubBrowser()
  vi.resetModules()
  mod = await import('./quoteSync')
  crmSync = await import('./crmSync')
  db = (await import('../db/database')).db
  await Promise.all([
    db.quoteOpQueue.clear(), db.quoteMirrors.clear(), db.quoteCatalog.clear(), db.meta.clear(), db.assignments.clear(),
  ])
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const ops = (draftId: string) => mod.quoteOpsForDraft(draftId)

/**
 * Queue while the phone KNOWS it is offline, so the passes each enqueue kicks are no-ops and the
 * test's own flush is the one and only try — attempt and call counts are then exact. (Each enqueue
 * kicks a pass, and one queued mid-pass schedules another; that is the engine's job, not the test's.)
 */
async function offlineWhile<T>(fn: () => Promise<T>): Promise<T> {
  vi.stubGlobal('navigator', { onLine: false })
  try {
    return await fn()
  } finally {
    await mod.flushQuoteQueue() // settle any no-op pass still in flight, while still offline
    vi.stubGlobal('navigator', { onLine: true })
  }
}

async function queueStartAndLine(draftId = D1, visitId = 'v1') {
  const start = await mod.enqueueQuoteOp({ draftId, visitId, body: { kind: 'start_quote', title: 'Hollis — 605 Green Farm Way' } })
  const add = await mod.enqueueQuoteOp({ draftId, visitId, body: { kind: 'add_line', lineId: L1, itemId: 'B002', quantity: 3, option: 'B' } })
  return { start, add }
}

describe('queueing is IndexedDB-first', () => {
  it('an edit is on the phone before any fetch, with the next seq for its draft; a dead network leaves it there with the reason', async () => {
    const fetchSpy = deadNetwork()
    const { start, add } = await offlineWhile(() => queueStartAndLine())
    expect(start.seq).toBe(1)
    expect(add.seq).toBe(2)
    // Written before the flush got anywhere.
    expect((await ops(D1)).map((o) => o.kind)).toEqual(['start_quote', 'add_line'])

    const outcome = await mod.awaitOp(add.opId)
    expect(outcome.state).toBe('waiting')
    const rows = await ops(D1)
    expect(rows[0]).toMatchObject({ status: 'queued', attempts: 1, lastError: 'Failed to fetch' })
    // The chain stopped at the first failure: the add was never tried, so it is not counted as tried.
    expect(rows[1]).toMatchObject({ status: 'queued', attempts: 0 })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(await mod.pendingQuoteOpCount(D1)).toBe(2)
  })

  it('seq is per draft — two drafts count independently', async () => {
    deadNetwork()
    await queueStartAndLine(D1)
    const other = await mod.enqueueQuoteOp({ draftId: D2, visitId: 'v2', body: { kind: 'start_quote' } })
    expect(other.seq).toBe(1)
    expect(await mod.pendingQuoteOpCount()).toBe(3)
  })

  it('the phone KNOWS it is offline (navigator.onLine false): nothing is attempted and nothing counts as a try', async () => {
    vi.stubGlobal('navigator', { onLine: false })
    const fetchSpy = deadNetwork()
    const { add } = await queueStartAndLine()
    const result = await mod.flushQuoteQueue()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(result).toMatchObject({ pushed: 0, remaining: 2, refused: 0 })
    expect((await db.quoteOpQueue.get(add.opId))!.attempts).toBe(0)
  })
})

describe('replay order and request shape', () => {
  it('one draft replays strictly in seq order through the id-carrying routes, with `expected` on every edit, then refreshes the saved copy', async () => {
    const server = mockServer((c) => {
      if (c.method === 'GET' && c.path === `/quotes/${D1}`) return { status: 200, data: serverQuote() }
      return { status: c.method === 'PUT' && c.path.startsWith('/visits/') ? 201 : 200, data: { draftId: D1, lineId: L1 } }
    })
    const last = await offlineWhile(async () => {
    await queueStartAndLine()
    await mod.enqueueQuoteOp({ draftId: D1, visitId: 'v1', body: { kind: 'edit_line', lineId: L1, patch: { quantity: 4 }, expected: { quantity: 3 } } })
    await mod.enqueueQuoteOp({ draftId: D1, visitId: 'v1', body: { kind: 'set_discount', type: 'custom', percent: 7.5, expected: { type: null, percent: null } } })
    await mod.enqueueQuoteOp({ draftId: D1, visitId: 'v1', body: { kind: 'add_option', option: 'D' } })
    await mod.enqueueQuoteOp({ draftId: D1, visitId: 'v1', body: { kind: 'set_option_meta', option: 'D', label: 'Garage', note: '', expected: { label: null, note: null } } })
    await mod.enqueueQuoteOp({ draftId: D1, visitId: 'v1', body: { kind: 'set_mode', exclusive: true, expected: { exclusive: false } } })
    await mod.enqueueQuoteOp({ draftId: D1, visitId: 'v1', body: { kind: 'set_details', title: 'Panel change', expected: { title: 'Hollis — 605 Green Farm Way' } } })
    await mod.enqueueQuoteOp({ draftId: D1, visitId: 'v1', body: { kind: 'line_order', order: [{ lineId: L1, option: 'A', was: 'B' }] } })
    await mod.enqueueQuoteOp({ draftId: D1, visitId: 'v1', body: { kind: 'remove_option', option: 'D', expectedLines: 0 } })
    return mod.enqueueQuoteOp({ draftId: D1, visitId: 'v1', body: { kind: 'remove_line', lineId: L1 } })
    })

    expect((await mod.awaitOp(last.opId)).state).toBe('delivered')
    expect(server.calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      `PUT /visits/v1/quote/${D1}`,
      `PUT /quotes/${D1}/lines/${L1}`,
      `PATCH /quote-lines/${L1}`,
      `PUT /quotes/${D1}/discount`,
      `POST /quotes/${D1}/options`,
      `PUT /quotes/${D1}/options/D`,
      `PUT /quotes/${D1}/options-mode`,
      `PUT /quotes/${D1}/details`,
      `PUT /quotes/${D1}/line-order`,
      `DELETE /quotes/${D1}/options/D?expectedLines=0`,
      `DELETE /quote-lines/${L1}`,
      `GET /quotes/${D1}`,
    ])
    expect(server.calls[1].body).toEqual({ itemId: 'B002', quantity: 3, option: 'B' })
    expect(server.calls[2].body).toEqual({ quantity: 4, expected: { quantity: 3 } })
    expect(server.calls[3].body).toEqual({ type: 'custom', percent: 7.5, expected: { type: null, percent: null } })
    expect(server.calls[4].body).toEqual({ option: 'D' })
    expect(server.calls[5].body).toEqual({ label: 'Garage', note: '', expected: { label: null, note: null } })
    expect(server.calls[6].body).toEqual({ exclusive: true, expected: { exclusive: false } })
    expect(server.calls[7].body).toEqual({ title: 'Panel change', expected: { title: 'Hollis — 605 Green Farm Way' } })
    expect(server.calls[8].body).toEqual({ order: [{ lineId: L1, option: 'A', was: 'B' }] })

    // Everything delivered and the saved copy refreshed from the office, flagged for the price check.
    expect(await ops(D1)).toEqual([])
    const mirror = await mod.quoteMirror(D1)
    expect(mirror).toMatchObject({ visitId: 'v1', origin: 'server', pricesNeedReview: true })
    expect(mirror!.payload.total).toBe(200.5)
  })

  it('a replay after a lost answer re-sends exactly what was queued — an edit is never changed after it is queued', async () => {
    const seen: unknown[] = []
    let first = true
    mockServer((c) => {
      if (c.method === 'PUT' && c.path.includes('/lines/')) {
        seen.push(c.body)
        if (first) { first = false; return { status: 503 } }
      }
      if (c.method === 'GET') return { status: 200, data: serverQuote() }
      return { status: 200, data: {} }
    })
    const add = await mod.enqueueQuoteOp({ draftId: D1, visitId: 'v1', body: { kind: 'add_line', lineId: L1, itemId: 'B002', quantity: 3 } })
    expect((await mod.awaitOp(add.opId)).state).toBe('waiting')
    expect((await mod.awaitOp(add.opId)).state).toBe('delivered')
    expect(seen).toEqual([{ itemId: 'B002', quantity: 3 }, { itemId: 'B002', quantity: 3 }])
  })
})

describe('the answer table', () => {
  it('a 5xx keeps the edit (attempts+1) and stops that draft for the pass; the next flush delivers it', async () => {
    let fail = true
    mockServer((c) => {
      if (c.method === 'GET') return { status: 200, data: serverQuote() }
      if (fail) return { status: 500, error: { message: 'Internal error' } }
      return { status: 200, data: {} }
    })
    const { start, add } = await offlineWhile(() => queueStartAndLine())
    await mod.flushQuoteQueue()
    expect(await db.quoteOpQueue.get(start.opId)).toMatchObject({ status: 'queued', attempts: 1, lastError: 'Internal error' })
    expect(await db.quoteOpQueue.get(add.opId)).toMatchObject({ status: 'queued', attempts: 0 })
    fail = false
    const result = await mod.flushQuoteQueue()
    expect(result.pushed).toBe(2)
    expect(await ops(D1)).toEqual([])
  })

  it('a 429 (the office\'s rate limiter) and a 408 are "not now", not "no": the edit stays queued, attempts+1, and the next flush delivers it', async () => {
    let status = 429
    mockServer((c) => {
      if (c.method === 'GET') return { status: 200, data: serverQuote() }
      if (status !== 200) return { status, error: { message: `CRM request failed (${status})` } }
      return { status: 200, data: {} }
    })
    const { start, add } = await offlineWhile(() => queueStartAndLine())
    await mod.flushQuoteQueue()
    expect(await db.quoteOpQueue.get(start.opId)).toMatchObject({ status: 'queued', attempts: 1, lastError: 'CRM request failed (429)' })
    expect(await db.quoteOpQueue.get(add.opId)).toMatchObject({ status: 'queued', attempts: 0 })
    status = 408
    await mod.flushQuoteQueue()
    expect(await db.quoteOpQueue.get(start.opId)).toMatchObject({ status: 'queued', attempts: 2, lastError: 'CRM request failed (408)' })
    status = 200
    expect((await mod.flushQuoteQueue()).pushed).toBe(2)
    expect(await ops(D1)).toEqual([])
  })

  it("a refusal (409 with the server's words) stops that draft's chain, is never retried on its own, and does not touch another draft", async () => {
    const server = mockServer((c) => {
      if (c.method === 'PATCH') return { status: 409, error: { code: 'conflict', message: 'Changed at the office since you last saw it: quantity was 3, now 5' } }
      if (c.method === 'GET') return { status: 200, data: serverQuote(c.path.endsWith(D2) ? D2 : D1) }
      return { status: 200, data: {} }
    })
    await db.quoteMirrors.put(mirrorOf(serverQuote()))
    const edit = await mod.enqueueQuoteOp({ draftId: D1, visitId: 'v1', body: { kind: 'edit_line', lineId: 'line-1', patch: { quantity: 4 }, expected: { quantity: 3 } } })
    const later = await mod.enqueueQuoteOp({ draftId: D1, visitId: 'v1', body: { kind: 'add_line', lineId: L1, itemId: 'B002', quantity: 1 } })
    const other = await mod.enqueueQuoteOp({ draftId: D2, visitId: 'v2', body: { kind: 'start_quote' } })

    const result = await mod.flushQuoteQueue()
    expect(result).toMatchObject({ pushed: 1, refused: 1, remaining: 2 })
    expect(await mod.quoteOpOutcome(edit.opId)).toMatchObject({ state: 'refused', reason: 'Changed at the office since you last saw it: quantity was 3, now 5' })
    expect(await db.quoteOpQueue.get(edit.opId)).toMatchObject({ status: 'refused', refusalCode: 'conflict', attempts: 1 })
    // The later edit on the same draft was never sent; the other draft went through.
    expect(await mod.quoteOpOutcome(later.opId)).toMatchObject({ state: 'waiting', reason: expect.stringContaining('refused') })
    expect(await db.quoteOpQueue.get(later.opId)).toMatchObject({ status: 'queued', attempts: 0 })
    expect(await db.quoteOpQueue.get(other.opId)).toBeUndefined()

    const before = server.calls.length
    await mod.flushQuoteQueue()
    expect(server.calls.length).toBe(before) // nothing re-sent, nothing new tried on the stopped draft
  })

  it('a 404 on a remove is done (already gone); a 404 on an edit is refused with the office\'s words', async () => {
    mockServer((c) => {
      if (c.method === 'DELETE') return { status: 404, error: { code: 'line_gone', message: 'That line is no longer on any quote.' } }
      if (c.method === 'PATCH') return { status: 404, error: { code: 'line_gone', message: 'That line is no longer on any quote — the office may have removed it.' } }
      if (c.method === 'GET') return { status: 200, data: serverQuote() }
      return { status: 200, data: {} }
    })
    const remove = await mod.enqueueQuoteOp({ draftId: D1, visitId: 'v1', body: { kind: 'remove_line', lineId: 'line-1' } })
    const removeOption = await mod.enqueueQuoteOp({ draftId: D1, visitId: 'v1', body: { kind: 'remove_option', option: 'D' } })
    const edit = await mod.enqueueQuoteOp({ draftId: D2, visitId: 'v2', body: { kind: 'edit_line', lineId: 'line-9', patch: { quantity: 2 } } })
    await mod.flushQuoteQueue()
    expect(await db.quoteOpQueue.get(remove.opId)).toBeUndefined()
    expect(await db.quoteOpQueue.get(removeOption.opId)).toBeUndefined()
    expect(await db.quoteOpQueue.get(edit.opId)).toMatchObject({ status: 'refused', refusalCode: 'line_gone', refusal: expect.stringContaining('the office may have removed it') })
  })

  it('a 401 keeps every edit untouched and stops the whole pass: "Sign in again"', async () => {
    const server = mockServer(() => ({ status: 401, error: { code: 'unauthorized', message: 'Token revoked' } }))
    const { start, add } = await offlineWhile(async () => {
      const queued = await queueStartAndLine()
      await mod.enqueueQuoteOp({ draftId: D2, visitId: 'v2', body: { kind: 'start_quote' } })
      return queued
    })
    const result = await mod.flushQuoteQueue()
    expect(result).toMatchObject({ authNeeded: true, pushed: 0, remaining: 3, refused: 0 })
    expect(server.calls.length).toBe(1)
    // Exactly one edit was tried (whichever draft the pass reached first); the other two were not.
    const rows = await db.quoteOpQueue.toArray()
    expect(rows.filter((o) => o.attempts === 1 && o.lastError === 'Token revoked' && o.status === 'queued')).toHaveLength(1)
    expect(rows.filter((o) => o.attempts === 0 && o.status === 'queued')).toHaveLength(2)
    expect(await db.quoteOpQueue.get(add.opId)).toMatchObject({ status: 'queued', attempts: 0 })
    expect(start.seq).toBe(1)
  })

  it('start-quote refused because the office started one first: the edit carries existingDraftId and the saved copy — written when the start was queued, with no figure in it — says pendingRebase', async () => {
    mockServer((c) => {
      if (c.method === 'PUT' && c.path.startsWith('/visits/')) {
        return { status: 409, error: { code: 'conflict', message: 'The office already started a quote for this visit', existingDraftId: 'office-draft' } }
      }
      return { status: 200, data: {} }
    })
    // No mirror is put by hand: queueing the start-quote is what writes the phone's copy.
    const { start, add } = await offlineWhile(() => queueStartAndLine())
    const phoneCopy = await mod.quoteMirror(D1)
    expect(phoneCopy).toMatchObject({ draftId: D1, visitId: 'v1', origin: 'phone', pricesNeedReview: false, pendingRebase: null })
    expect(phoneCopy!.payload.title).toBe('Hollis — 605 Green Farm Way')
    expect(phoneCopy!.payload.total).toBeNull()
    expect(phoneCopy!.payload.options).toEqual([])
    expect(phoneCopy!.payload.money).toMatchObject({ discountedTotal: null, range: null, selections: {}, financing: null })
    await mod.flushQuoteQueue()
    expect(await db.quoteOpQueue.get(start.opId)).toMatchObject({ status: 'refused', existingDraftId: 'office-draft' })
    expect(await db.quoteOpQueue.get(add.opId)).toMatchObject({ status: 'queued', attempts: 0 })
    expect((await mod.quoteMirror(D1))!.pendingRebase).toBe('office-draft')
    expect((await mod.loadQuoteView(D1)).pendingRebase).toBe('office-draft')

    // A copy the office already sent is never overwritten by a queued start (a replay of the screen's open).
    await db.quoteMirrors.put(mirrorOf(serverQuote(D2), { visitId: 'v2' }))
    await offlineWhile(() => mod.enqueueQuoteOp({ draftId: D2, visitId: 'v2', body: { kind: 'start_quote', title: 'x' } }))
    expect((await mod.quoteMirror(D2))!.origin).toBe('server')
  })
})

describe('an edit made during a flush survives', () => {
  it('a line queued while the pass was already past its draft is still sent before anyone is told "flushed"', async () => {
    const server = mockServer(async (c) => {
      if (c.method === 'PUT' && c.path.startsWith('/visits/')) {
        // The tech keeps working while the first request is in the air.
        await mod.enqueueQuoteOp({ draftId: D1, visitId: 'v1', body: { kind: 'add_line', lineId: L2, itemId: 'A016', quantity: 1 } })
        return { status: 201, data: { draftId: D1, resumed: false } }
      }
      if (c.method === 'GET') return { status: 200, data: serverQuote() }
      return { status: 200, data: {} }
    })
    const { add } = await queueStartAndLine()
    expect((await mod.awaitOp(add.opId)).state).toBe('delivered')
    expect(server.calls.filter((c) => c.method === 'PUT' && c.path.includes('/lines/')).map((c) => c.path)).toEqual([
      `/quotes/${D1}/lines/${L1}`,
      `/quotes/${D1}/lines/${L2}`,
    ])
    expect(await ops(D1)).toEqual([])
  })
})

describe('delivered rows wait for the saved copy', () => {
  it('after a 2xx the row is marked delivered; it is deleted only once the office\'s copy is refreshed, and never re-sent meanwhile', async () => {
    let refreshFails = true
    const server = mockServer((c) => {
      if (c.method === 'GET') return refreshFails ? { status: 500, error: { message: 'db down' } } : { status: 200, data: serverQuote() }
      return { status: 200, data: {} }
    })
    await db.quoteMirrors.put(mirrorOf(serverQuote()))
    const add = await mod.enqueueQuoteOp({ draftId: D1, visitId: 'v1', body: { kind: 'add_line', lineId: L1, itemId: 'B002', quantity: 1 } })
    expect((await mod.awaitOp(add.opId)).state).toBe('delivered')
    expect(await db.quoteOpQueue.get(add.opId)).toMatchObject({ status: 'delivered' })
    expect(await mod.pendingQuoteOpCount(D1)).toBe(0)
    // Still laid over the copy the phone has, so the screen shows what the tech did.
    expect((await mod.loadQuoteView(D1)).lines.map((l) => l.id)).toEqual(['line-1', 'line-2', L1])

    refreshFails = false
    await mod.flushQuoteQueue()
    expect(server.calls.filter((c) => c.method === 'PUT').length).toBe(1)
    expect(await db.quoteOpQueue.get(add.opId)).toBeUndefined()
    expect((await mod.quoteMirror(D1))!.pricesNeedReview).toBe(true)
    await mod.markPricesReviewed(D1)
    expect((await mod.quoteMirror(D1))!.pricesNeedReview).toBe(false)
  })
})

describe('Discard', () => {
  beforeEach(() => { deadNetwork() })

  it('discarding an add takes the edit and remove of that line and the order that named it, and returns them', async () => {
    const add = await mod.enqueueQuoteOp({ draftId: D1, visitId: 'v1', body: { kind: 'add_line', lineId: L1, itemId: 'B002', quantity: 1 } })
    const edit = await mod.enqueueQuoteOp({ draftId: D1, visitId: 'v1', body: { kind: 'edit_line', lineId: L1, patch: { quantity: 2 } } })
    const unrelated = await mod.enqueueQuoteOp({ draftId: D1, visitId: 'v1', body: { kind: 'edit_line', lineId: 'line-1', patch: { quantity: 2 } } })
    const order = await mod.enqueueQuoteOp({ draftId: D1, visitId: 'v1', body: { kind: 'line_order', order: [{ lineId: L1, option: 'A' }, { lineId: 'line-1', option: 'A' }] } })
    const { discarded } = await mod.discardQuoteOp(add.opId)
    expect(discarded.map((o) => o.opId)).toEqual([add.opId, edit.opId, order.opId])
    expect((await ops(D1)).map((o) => o.opId)).toEqual([unrelated.opId])
  })

  it('discarding an add-option takes the lines put into it, and their edits (transitively)', async () => {
    const addOption = await mod.enqueueQuoteOp({ draftId: D1, visitId: 'v1', body: { kind: 'add_option', option: 'D' } })
    const addLine = await mod.enqueueQuoteOp({ draftId: D1, visitId: 'v1', body: { kind: 'add_line', lineId: L1, itemId: 'B002', quantity: 1, option: 'D' } })
    const editLine = await mod.enqueueQuoteOp({ draftId: D1, visitId: 'v1', body: { kind: 'edit_line', lineId: L1, patch: { note: 'x' } } })
    const name = await mod.enqueueQuoteOp({ draftId: D1, visitId: 'v1', body: { kind: 'set_option_meta', option: 'D', label: 'Garage', note: '' } })
    const keep = await mod.enqueueQuoteOp({ draftId: D1, visitId: 'v1', body: { kind: 'add_line', lineId: L2, itemId: 'A016', quantity: 1, option: 'A' } })
    const { discarded } = await mod.discardQuoteOp(addOption.opId)
    expect(discarded.map((o) => o.opId)).toEqual([addOption.opId, addLine.opId, editLine.opId, name.opId])
    expect((await ops(D1)).map((o) => o.opId)).toEqual([keep.opId])
  })

  it('discarding an edit takes the later edit to the SAME field (its expected was read off the first) — not one to another field, and not another line', async () => {
    const first = await mod.enqueueQuoteOp({ draftId: D1, visitId: 'v1', body: { kind: 'edit_line', lineId: 'line-1', patch: { quantity: 5 }, expected: { quantity: 3 } } })
    const second = await mod.enqueueQuoteOp({ draftId: D1, visitId: 'v1', body: { kind: 'edit_line', lineId: 'line-1', patch: { quantity: 7 }, expected: { quantity: 5 } } })
    const otherField = await mod.enqueueQuoteOp({ draftId: D1, visitId: 'v1', body: { kind: 'edit_line', lineId: 'line-1', patch: { note: 'left wall' }, expected: { note: null } } })
    const otherLine = await mod.enqueueQuoteOp({ draftId: D1, visitId: 'v1', body: { kind: 'edit_line', lineId: 'line-2', patch: { quantity: 9 }, expected: { quantity: 1 } } })
    const third = await mod.enqueueQuoteOp({ draftId: D1, visitId: 'v1', body: { kind: 'edit_line', lineId: 'line-1', patch: { quantity: 8, note: 'x' }, expected: { quantity: 7, note: 'left wall' } } })
    const { discarded } = await mod.discardQuoteOp(first.opId)
    // `third` goes through `second` (transitively), not through `otherField` — which stays.
    expect(discarded.map((o) => o.opId)).toEqual([first.opId, second.opId, third.opId])
    expect((await ops(D1)).map((o) => o.opId)).toEqual([otherField.opId, otherLine.opId])
  })

  it('discarding a setting takes the later setting of the same kind (same option for a name); a reorder takes the reorder after it', async () => {
    const discount1 = await mod.enqueueQuoteOp({ draftId: D1, visitId: 'v1', body: { kind: 'set_discount', type: 'military', percent: null, expected: { type: null, percent: null } } })
    const discount2 = await mod.enqueueQuoteOp({ draftId: D1, visitId: 'v1', body: { kind: 'set_discount', type: 'senior', percent: null, expected: { type: 'military', percent: null } } })
    const nameB = await mod.enqueueQuoteOp({ draftId: D1, visitId: 'v1', body: { kind: 'set_option_meta', option: 'B', label: 'Garage', note: '' } })
    const nameC = await mod.enqueueQuoteOp({ draftId: D1, visitId: 'v1', body: { kind: 'set_option_meta', option: 'C', label: 'Shed', note: '' } })
    const nameB2 = await mod.enqueueQuoteOp({ draftId: D1, visitId: 'v1', body: { kind: 'set_option_meta', option: 'B', label: 'Garage lights', note: '', expected: { label: 'Garage', note: null } } })
    expect((await mod.discardQuoteOp(discount1.opId)).discarded.map((o) => o.opId)).toEqual([discount1.opId, discount2.opId])
    expect((await mod.discardQuoteOp(nameB.opId)).discarded.map((o) => o.opId)).toEqual([nameB.opId, nameB2.opId])
    expect((await ops(D1)).map((o) => o.opId)).toEqual([nameC.opId])

    const order1 = await mod.enqueueQuoteOp({ draftId: D2, visitId: 'v2', body: { kind: 'line_order', order: [{ lineId: 'line-2', option: 'B', was: 'A' }, { lineId: 'line-1', option: 'A', was: 'A' }] } })
    const moveBack = await mod.enqueueQuoteOp({ draftId: D2, visitId: 'v2', body: { kind: 'edit_line', lineId: 'line-2', patch: { option: 'A' }, expected: { option: 'B' } } })
    const order2 = await mod.enqueueQuoteOp({ draftId: D2, visitId: 'v2', body: { kind: 'line_order', order: [{ lineId: 'line-1', option: 'A', was: 'A' }, { lineId: 'line-2', option: 'A', was: 'A' }] } })
    const untouched = await mod.enqueueQuoteOp({ draftId: D2, visitId: 'v2', body: { kind: 'edit_line', lineId: 'line-1', patch: { quantity: 4 }, expected: { quantity: 2 } } })
    expect((await mod.discardQuoteOp(order1.opId)).discarded.map((o) => o.opId)).toEqual([order1.opId, moveBack.opId, order2.opId])
    expect((await ops(D2)).map((o) => o.opId)).toEqual([untouched.opId])
  })

  it('discarding the start-quote takes everything on that draft and clears pendingRebase; "Discard all" does the same', async () => {
    await db.quoteMirrors.put(mirrorOf(mod.emptyQuoteState(D1), { origin: 'phone', pendingRebase: 'office-draft' }))
    const { start } = await queueStartAndLine()
    await db.quoteOpQueue.update(start.opId, { status: 'refused', existingDraftId: 'office-draft' })
    const { discarded } = await mod.discardQuoteOp(start.opId)
    expect(discarded.length).toBe(2)
    expect(await ops(D1)).toEqual([])
    expect((await mod.quoteMirror(D1))!.pendingRebase).toBeNull()

    await queueStartAndLine()
    expect((await mod.discardAllQuoteOps(D1)).discarded.length).toBe(2)
    expect(await mod.pendingQuoteOpCount()).toBe(0)
  })

  it('a delivered change cannot be discarded; discarding a refused one lets the rest of the draft replay', async () => {
    const delivered = await mod.enqueueQuoteOp({ draftId: D1, visitId: 'v1', body: { kind: 'add_line', lineId: L1, itemId: 'B002', quantity: 1 } })
    await db.quoteOpQueue.update(delivered.opId, { status: 'delivered' })
    await expect(mod.discardQuoteOp(delivered.opId)).rejects.toThrow(/already reached the office/)

    const refused = await mod.enqueueQuoteOp({ draftId: D2, visitId: 'v2', body: { kind: 'edit_line', lineId: 'line-1', patch: { quantity: 9 } } })
    await db.quoteOpQueue.update(refused.opId, { status: 'refused', refusal: 'no' })
    const next = await mod.enqueueQuoteOp({ draftId: D2, visitId: 'v2', body: { kind: 'add_line', lineId: L2, itemId: 'A016', quantity: 1 } })
    await mod.discardQuoteOp(refused.opId)
    mockServer((c) => (c.method === 'GET' ? { status: 200, data: serverQuote(D2) } : { status: 200, data: {} }))
    expect((await mod.awaitOp(next.opId)).state).toBe('delivered')
  })
})

describe('Discard while a flush is in the air', () => {
  it('a change discarded while an earlier one hangs on the wire is never sent; the one on the wire cannot be discarded until it lands', async () => {
    let releaseFirst!: () => void
    const firstOnTheWire = new Promise<void>((resolve) => {
      const held = new Promise<void>((r) => { releaseFirst = r })
      mockServer(async (c) => {
        if (c.method === 'GET') return { status: 200, data: serverQuote() }
        if (c.method === 'PATCH' && c.path === '/quote-lines/line-1') {
          resolve()
          await held
        }
        return { status: 200, data: {} }
      })
    })
    const { first, second } = await offlineWhile(async () => ({
      first: await mod.enqueueQuoteOp({ draftId: D1, visitId: 'v1', body: { kind: 'edit_line', lineId: 'line-1', patch: { quantity: 5 }, expected: { quantity: 2 } } }),
      second: await mod.enqueueQuoteOp({ draftId: D1, visitId: 'v1', body: { kind: 'edit_line', lineId: 'line-2', patch: { note: 'x' }, expected: { note: 'left wall' } } }),
    }))
    const flush = mod.flushQuoteQueue()
    await firstOnTheWire
    // The tech changes their mind about the second while the first is still being sent.
    await expect(mod.discardQuoteOp(first.opId)).rejects.toThrow(/being sent to the office right now/)
    await expect(mod.discardAllQuoteOps(D1)).rejects.toThrow(/being sent to the office right now/)
    expect((await ops(D1)).length).toBe(2)
    expect((await mod.discardQuoteOp(second.opId)).discarded.map((o) => o.opId)).toEqual([second.opId])
    releaseFirst()
    const result = await flush
    expect(result.pushed).toBe(1)
    const server = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map(([url, init]) => `${(init as RequestInit)?.method ?? 'GET'} ${String(url).replace(BASE, '')}`)
    expect(server).toContain('PATCH /quote-lines/line-1')
    expect(server).not.toContain('PATCH /quote-lines/line-2')
    expect(await ops(D1)).toEqual([])
  })
})

describe('rebase: "Add my N lines to it"', () => {
  it('re-points line and option edits at the office\'s draft after its queue, drops the start-quote, applies only the chosen settings with the office\'s value as expected', async () => {
    deadNetwork()
    await db.quoteMirrors.put(mirrorOf(mod.emptyQuoteState(D1), { origin: 'phone', pendingRebase: 'office-draft' }))
    await db.quoteMirrors.put(mirrorOf(serverQuote('office-draft'), { pendingRebase: null }))
    const waitingOnOffice = await mod.enqueueQuoteOp({ draftId: 'office-draft', visitId: 'v1', body: { kind: 'add_line', lineId: L2, itemId: 'A016', quantity: 1 } })
    const { start, add } = await queueStartAndLine()
    await db.quoteOpQueue.update(start.opId, { status: 'refused', existingDraftId: 'office-draft', refusal: 'The office already started a quote for this visit' })
    const edit = await mod.enqueueQuoteOp({ draftId: D1, visitId: 'v1', body: { kind: 'edit_line', lineId: L1, patch: { quantity: 4 }, expected: { quantity: 3 } } })
    const details = await mod.enqueueQuoteOp({ draftId: D1, visitId: 'v1', body: { kind: 'set_details', title: 'Panel change', expected: { title: 'Hollis' } } })
    const discount = await mod.enqueueQuoteOp({ draftId: D1, visitId: 'v1', body: { kind: 'set_discount', type: 'senior', percent: null, expected: { type: null, percent: null } } })
    const mode = await mod.enqueueQuoteOp({ draftId: D1, visitId: 'v1', body: { kind: 'set_mode', exclusive: true, expected: { exclusive: false } } })
    const meta = await mod.enqueueQuoteOp({ draftId: D1, visitId: 'v1', body: { kind: 'set_option_meta', option: 'B', label: 'Code fixes', note: '', expected: { label: null, note: null } } })

    const office = serverQuote('office-draft') // carries a MILITARY discount, shown as 5%
    const { moved, dropped } = await mod.rebaseQuoteOps(D1, 'office-draft', { applySettings: [details.opId, discount.opId, meta.opId], office })

    expect(moved.map((o) => [o.opId, o.seq, o.draftId, o.status])).toEqual([
      [add.opId, 2, 'office-draft', 'queued'],
      [edit.opId, 3, 'office-draft', 'queued'],
      [details.opId, 4, 'office-draft', 'queued'],
      [discount.opId, 5, 'office-draft', 'queued'],
      [meta.opId, 6, 'office-draft', 'queued'],
    ])
    expect(dropped.map((o) => o.opId)).toEqual([mode.opId])
    // The office's CURRENT value rides as expected — and the discount's percent is the STORED one
    // (null for military/senior), never the 5 the office's row displays.
    expect(moved[2].body).toMatchObject({ kind: 'set_details', expected: { title: 'Hollis — 605 Green Farm Way', jobDescription: 'Replace the panel.' } })
    expect(moved[3].body).toMatchObject({ kind: 'set_discount', expected: { type: 'military', percent: null } })
    expect(moved[4].body).toMatchObject({ kind: 'set_option_meta', expected: { label: null, note: null } })
    // The line edit keeps its own expected and its phone-minted line id.
    expect(moved[1].body).toMatchObject({ kind: 'edit_line', lineId: L1, expected: { quantity: 3 } })
    expect((await ops('office-draft')).map((o) => o.opId)).toEqual([waitingOnOffice.opId, add.opId, edit.opId, details.opId, discount.opId, meta.opId])
    expect(await ops(D1)).toEqual([])
    expect(await mod.quoteMirror(D1)).toBeUndefined()
    expect((await mod.quoteMirror('office-draft'))!.pendingRebase).toBeNull()
  })

  it('a draft with a delivered change cannot be rebased', async () => {
    deadNetwork()
    const { add } = await queueStartAndLine()
    await db.quoteOpQueue.update(add.opId, { status: 'delivered' })
    await expect(mod.rebaseQuoteOps(D1, 'office-draft')).rejects.toThrow(/already reached the office/)
  })
})

describe('"Delete this quote" on a phone-only quote', () => {
  it('removes its edits and its copy; a quote the office has is refused with why', async () => {
    deadNetwork()
    await db.quoteMirrors.put(mirrorOf(mod.emptyQuoteState(D1), { origin: 'phone' }))
    await queueStartAndLine()
    expect(await mod.deleteLocalOnlyQuote(D1)).toEqual({ deleted: true, changes: 2 })
    expect(await ops(D1)).toEqual([])
    expect(await mod.quoteMirror(D1)).toBeUndefined()

    await db.quoteMirrors.put(mirrorOf(serverQuote(D2)))
    await mod.enqueueQuoteOp({ draftId: D2, visitId: 'v2', body: { kind: 'add_line', lineId: L1, itemId: 'B002', quantity: 1 } })
    await expect(mod.deleteLocalOnlyQuote(D2)).rejects.toThrow(/The office has this quote/)
    expect(await mod.pendingQuoteOpCount(D2)).toBe(1)
  })
})

describe('the overlay never shows a number the office did not supply', () => {
  const catalog = new Map(CATALOG.rows.map((r) => [r.itemId, r]))
  const op = (seq: number, body: QuoteOpRecord['body'], status: QuoteOpRecord['status'] = 'queued'): QuoteOpRecord => ({
    opId: `op-${seq}`, draftId: D1, visitId: 'v1', seq, kind: body.kind, body, status, attempts: 0, queuedAt: 'now',
  })

  it('with nothing waiting, every figure is the office\'s, exactly', () => {
    const view = mod.overlayQuote(mirrorOf(serverQuote()), [])
    expect(view.touched).toBe(false)
    expect(view.priceSource).toBe('server')
    expect(view.total).toBe(200.5)
    expect(view.lines.map((l) => l.lineTotal)).toEqual([120.5, 80])
    expect(view.money).toEqual(serverQuote().money)
    expect(view.options).toEqual(serverQuote().options)
    expect(view.lines.every((l) => !l.pendingPrice && !l.localOnly)).toBe(true)
    expect(view.snapshotAt).toBe('2026-10-09T14:14:00.000Z')
  })

  it('a touched line is unpriced, an untouched one keeps its figure, and every aggregate is blank', () => {
    const view = mod.overlayQuote(mirrorOf(serverQuote()), [
      op(1, { kind: 'add_line', lineId: L1, itemId: 'W142', quantity: 40, option: 'B' }),
      op(2, { kind: 'edit_line', lineId: 'line-1', patch: { quantity: 3 }, expected: { quantity: 2 } }),
    ], catalog)
    expect(view.touched).toBe(true)
    expect(view.priceSource).toBe('none')
    const [l1, l2, added] = view.lines
    expect(l1).toMatchObject({ id: 'line-1', quantity: 3, lineTotal: null, pendingPrice: true, localOnly: false, pendingOpIds: ['op-2'] })
    expect(l2).toMatchObject({ id: 'line-2', quantity: 1, lineTotal: 80, pendingPrice: false })
    expect(added).toMatchObject({ id: L1, itemId: 'W142', description: '14/2 NM-B', quantity: 40, quantitySource: 'MEASURED_LENGTH', option: 'B', lineTotal: null, pendingPrice: true, localOnly: true })
    expect(view.total).toBeNull()
    expect(view.options).toEqual([{ option: 'A', lineCount: 2, subtotal: null, complete: false }, { option: 'B', lineCount: 1, subtotal: null, complete: false }])
    expect(view.money.selections).toEqual({})
    expect(view.money.discountedTotal).toBeNull()
    expect(view.money.discountedRange).toBeNull()
    expect(view.money.range).toBeNull()
    expect(view.money.financing).toBeNull()
    expect(view.money.discount).toMatchObject({ type: 'military', label: 'Military discount (5%)', rows: [] })
    expect(view.money.pickable).toEqual(['A', 'B'])
    expect(view.optionSet.options.map((o) => [o.option, o.lineCount])).toEqual([['A', 2], ['B', 1], ['C', 0]])
    // The proof: every number in the money part of the view came from the office (80 is the one
    // line figure that survives; 5 is the discount's programme percent, words not dollars) or
    // from the tech's own counts. No $-figure exists that the office did not send.
    const dollarsShown = numbersIn({ total: view.total, subtotals: view.options.map((o) => o.subtotal), selections: view.money.selections, lineTotals: view.lines.map((l) => l.lineTotal), discountedTotal: view.money.discountedTotal, discountRows: view.money.discount?.rows })
    expect([...dollarsShown]).toEqual([80])
  })

  it('a phone-only quote has no figure anywhere: the title from the start, A/B/C, blank money', () => {
    const view = mod.overlayQuote(null, [
      op(1, { kind: 'start_quote', title: 'Hollis — 605 Green Farm Way' }),
      op(2, { kind: 'add_line', lineId: L1, itemId: 'B002', quantity: 2 }),
    ], catalog)
    expect(view).toMatchObject({ draftId: D1, title: 'Hollis — 605 Green Farm Way', localOnlyQuote: true, snapshotAt: null, total: null, touched: true })
    expect(view.lines).toHaveLength(1)
    expect(view.lines[0]).toMatchObject({ description: 'Duplex receptacle', quantity: 2, lineTotal: null, pendingPrice: true, localOnly: true })
    expect(view.optionSet.options.map((o) => o.option)).toEqual(['A', 'B', 'C'])
    expect(view.optionSet.nextOption).toBe('D')
    expect(numbersIn({ money: view.money, total: view.total, options: view.options.map((o) => o.subtotal) }).size).toBe(0)
    // An item not in the saved book still shows, by its code.
    const unknown = mod.overlayQuote(null, [op(1, { kind: 'add_line', lineId: L1, itemId: 'ZZ99', quantity: 1 })])
    expect(unknown.lines[0].description).toBe('ZZ99')
  })

  it('refused edits are not laid over (listed for the banner); delivered ones are', () => {
    const view = mod.overlayQuote(mirrorOf(serverQuote()), [
      op(1, { kind: 'edit_line', lineId: 'line-1', patch: { quantity: 9 } }, 'refused'),
      op(2, { kind: 'edit_line', lineId: 'line-2', patch: { location: 'Attic' } }, 'delivered'),
    ])
    expect(view.lines[0].quantity).toBe(2)
    expect(view.lines[1]).toMatchObject({ location: 'Attic', lineTotal: null, pendingPrice: true })
    expect(view.refused.map((o) => o.opId)).toEqual(['op-1'])
    expect(view.waiting.map((o) => o.opId)).toEqual(['op-2'])
  })

  it('settings, options, names, removals and order apply as words — a moved line is unpriced, a reordered one keeps its figure', () => {
    const issued: QuoteState = { ...serverQuote(), lifecycle: { ...serverQuote().lifecycle, issued: { estimateId: 'e1', number: '2026-1098', revision: 1, status: 'sent', signedAt: null, issuedAt: '2026-10-01T12:00:00.000Z', validDays: 30, figuresKey: 'k', archived: false, customerUrl: null } } }
    const view = mod.overlayQuote(mirrorOf(issued), [
      op(1, { kind: 'set_details', title: 'Panel change', jobDescription: null }),
      op(2, { kind: 'set_mode', exclusive: true }),
      op(3, { kind: 'add_option', option: 'D' }),
      op(4, { kind: 'set_option_meta', option: 'D', label: 'Garage', note: '  ' }),
      op(5, { kind: 'add_line', lineId: L1, itemId: 'A016', quantity: 1, option: 'D' }),
      op(6, { kind: 'set_discount', type: 'custom', percent: 7.5 }),
      op(7, { kind: 'line_order', order: [{ lineId: 'line-2', option: 'A' }, { lineId: 'line-1', option: 'B', was: 'A' }] }),
      op(8, { kind: 'remove_line', lineId: L1 }),
      op(9, { kind: 'remove_option', option: 'D' }),
    ])
    expect(view.title).toBe('Panel change')
    expect(view.jobDescription).toBeNull()
    expect(view.money.exclusiveOptions).toBe(true)
    expect(view.optionSet.options.map((o) => o.option)).toEqual(['A', 'B', 'C'])
    expect(view.optionSet.nextOption).toBe('D')
    expect(view.pendingDiscount).toEqual({ type: 'custom', percent: 7.5 })
    // Order applied: line-2 first (reordered only, still priced), line-1 moved to B (unpriced).
    expect(view.lines.map((l) => [l.id, l.option, l.lineTotal, l.pendingPrice])).toEqual([
      ['line-2', 'A', 80, false],
      ['line-1', 'B', null, true],
    ])
    expect(view.lifecycle.hasUnsavedChanges).toBe(true)

    const named = mod.overlayQuote(mirrorOf(serverQuote()), [
      op(1, { kind: 'add_option', option: 'D' }),
      op(2, { kind: 'set_option_meta', option: 'D', label: 'Garage', note: '  ' }),
      op(3, { kind: 'set_discount', type: 'military', percent: null }),
    ])
    expect(named.optionSet.options.find((o) => o.option === 'D')).toMatchObject({ label: 'Garage', note: null, removable: true, lineCount: 0 })
    expect(named.optionSet.nextOption).toBe('E')
    expect(named.pendingDiscount).toEqual({ type: 'military', percent: null })
  })

  it('expectedForLine reads the fields the patch changes off the line as shown', () => {
    const line = serverQuote().lines[1]
    expect(mod.expectedForLine(line, { quantity: 3, note: 'x' })).toEqual({ quantity: 1, note: 'left wall' })
    expect(mod.expectedForLine(line, { option: 'B' })).toEqual({ option: 'A' })
  })

  it('a waiting name edit is laid over the line, and its expected is the name as the screen showed it (Kyle, 2026-10-27)', () => {
    const view = mod.overlayQuote(mirrorOf(serverQuote()), [
      op(1, { kind: 'edit_line', lineId: 'line-1', patch: { customName: 'Panel - Jones garage' }, expected: { customName: null } }),
    ], catalog)
    expect(view.lines[0].customName).toBe('Panel - Jones garage')
    expect(view.lines[1].customName ?? null).toBeNull()
    const cleared = mod.overlayQuote(mirrorOf(serverQuote()), [
      op(1, { kind: 'edit_line', lineId: 'line-1', patch: { customName: 'Panel - Jones garage' } }),
      op(2, { kind: 'edit_line', lineId: 'line-1', patch: { customName: null }, expected: { customName: 'Panel - Jones garage' } }),
    ], catalog)
    expect(cleared.lines[0].customName).toBeNull()
    // expected: the line as the screen shows it, a missing name reading as null.
    const line = serverQuote().lines[0]
    expect(mod.expectedForLine(line, { customName: 'x' })).toEqual({ customName: null })
    expect(mod.expectedForLine({ ...line, customName: 'Panel - Jones garage' }, { customName: null })).toEqual({ customName: 'Panel - Jones garage' })
  })
})

describe('the saved copy (quoteMirrors)', () => {
  it('fetchQuote saves the office\'s answer; the visit is kept across a save that does not know it', async () => {
    mockServer(() => ({ status: 200, data: serverQuote() }))
    await crmSync.fetchQuote(D1, { visitId: 'v1' })
    expect(await mod.quoteMirrorForVisit('v1')).toMatchObject({ draftId: D1, origin: 'server', pricesNeedReview: false })
    await crmSync.fetchQuote(D1)
    expect((await mod.quoteMirror(D1))!.visitId).toBe('v1')
    expect((await mod.quoteMirror(D1))!.payload.total).toBe(200.5)
  })

  it('cacheVisitQuotes reads every assigned visit\'s quote with the read-only GET — never the POST that starts one', async () => {
    const server = mockServer((c) => {
      if (c.path === '/visits/v1/quote') return { status: 200, data: { draftId: D1 } }
      if (c.path === '/visits/v2/quote') return { status: 404, error: { code: 'not_found', message: 'This visit has no quote yet' } }
      if (c.path === '/visits/v3/quote') return { status: 500, error: { message: 'db down' } }
      if (c.path === `/quotes/${D1}`) return { status: 200, data: serverQuote() }
      return { status: 500 }
    })
    await db.assignments.bulkPut([
      { visitId: 'v1', assignmentId: 'a1', cachedAt: 'now' },
      { visitId: 'v2', assignmentId: 'a2', cachedAt: 'now' },
      { visitId: 'v3', assignmentId: 'a3', cachedAt: 'now' },
    ] as never[])
    expect(await mod.cacheVisitQuotes()).toEqual({ cached: 1, none: 1, failed: 1 })
    expect(server.calls.every((c) => c.method === 'GET')).toBe(true)
    expect(await mod.quoteMirrorForVisit('v1')).toMatchObject({ draftId: D1, visitId: 'v1', origin: 'server' })
    expect(await mod.quoteMirrorForVisit('v2')).toBeUndefined()
  })
})

describe('the saved copies do not outlive their visits', () => {
  it('pruneQuoteMirrors drops the copy of a visit no longer assigned — unless an edit still waits on it; cacheVisitQuotes prunes; "Disconnect" drops every idle copy', async () => {
    const D3 = '33333333-3333-4333-8333-333333333333'
    await db.quoteMirrors.bulkPut([
      mirrorOf(serverQuote(D1), { visitId: 'v1' }),
      mirrorOf(serverQuote(D2), { visitId: 'v2' }),
      mirrorOf(serverQuote(D3), { visitId: 'v3' }),
    ])
    await offlineWhile(() => mod.enqueueQuoteOp({ draftId: D3, visitId: 'v3', body: { kind: 'edit_line', lineId: 'line-1', patch: { quantity: 4 }, expected: { quantity: 2 } } }))
    expect(await mod.pruneQuoteMirrors({ keepVisitIds: ['v1'] })).toEqual({ pruned: 1 })
    expect((await db.quoteMirrors.toArray()).map((m) => m.draftId).sort()).toEqual([D1, D3].sort())

    mockServer((c) => {
      if (c.path === '/visits/v1/quote') return { status: 200, data: { draftId: D1 } }
      if (c.path === `/quotes/${D1}`) return { status: 200, data: serverQuote() }
      return { status: 404, error: { code: 'not_found', message: 'no quote' } }
    })
    await db.assignments.bulkPut([{ visitId: 'v1', assignmentId: 'a1', cachedAt: 'now' }] as never[])
    await db.quoteMirrors.put(mirrorOf(serverQuote(D2), { visitId: 'v2' }))
    await mod.cacheVisitQuotes()
    expect((await db.quoteMirrors.toArray()).map((m) => m.draftId).sort()).toEqual([D1, D3].sort())

    expect(await mod.forgetOfficeCopies()).toEqual({ pruned: 1 })
    expect((await db.quoteMirrors.toArray()).map((m) => m.draftId)).toEqual([D3])
    expect(await mod.pendingQuoteOpCount(D3)).toBe(1)
  })
})

describe('the saved price book (quoteCatalog)', () => {
  it('saves every row in the server\'s order, skips an unchanged version, and prunes an item the office retired', async () => {
    let snapshot = CATALOG
    const server = mockServer((c) => {
      if (c.path.startsWith('/quote-catalog/snapshot')) {
        const version = new URL(`https://x${c.path}`).searchParams.get('version')
        return version === snapshot.version ? { status: 200, data: { unchanged: true, version } } : { status: 200, data: snapshot }
      }
      return { status: 500 }
    })
    const first = await mod.syncQuoteCatalog()
    expect(first).toMatchObject({ stale: false, unchanged: false, meta: { version: 'v1', count: 3, sections: CATALOG.sections } })
    expect(server.calls[0].path).toBe('/quote-catalog/snapshot')
    expect((await db.quoteCatalog.orderBy('position').toArray()).map((r) => r.itemId)).toEqual(['B002', 'A016', 'W142'])

    const second = await mod.syncQuoteCatalog()
    expect(second).toMatchObject({ stale: false, unchanged: true, meta: { version: 'v1' } })
    expect(server.calls[1].path).toBe('/quote-catalog/snapshot?version=v1')
    expect(await db.quoteCatalog.count()).toBe(3)

    snapshot = { ...CATALOG, version: 'v2', rows: CATALOG.rows.filter((r) => r.itemId !== 'A016'), sections: [{ section: 'Devices', itemCount: 1 }, { section: 'Wire', itemCount: 1 }] }
    const third = await mod.syncQuoteCatalog()
    expect(third.meta).toMatchObject({ version: 'v2', count: 2 })
    expect((await db.quoteCatalog.toArray()).map((r) => r.itemId).sort()).toEqual(['B002', 'W142'])
    expect((await mod.cachedCatalogMeta())!.sections).toEqual(snapshot.sections)

    // A failed refresh leaves the saved copy standing, and says so.
    deadNetwork()
    expect(await mod.syncQuoteCatalog()).toMatchObject({ stale: true, unchanged: false, meta: { version: 'v2' }, error: 'Failed to fetch' })
    expect(await db.quoteCatalog.count()).toBe(2)
  })

  it('searchCachedCatalog: the online picker\'s test, in the server\'s order, cut at the same page size', async () => {
    mockServer(() => ({ status: 200, data: CATALOG }))
    await mod.syncQuoteCatalog()
    expect((await mod.searchCachedCatalog({ search: 'recep' })).atomics.map((r) => r.itemId)).toEqual(['B002'])
    expect((await mod.searchCachedCatalog({ section: 'devices' })).atomics.map((r) => r.itemId)).toEqual(['B002', 'A016'])
    expect((await mod.searchCachedCatalog({ search: 'SWITCH', section: 'Devices' })).atomics.map((r) => r.itemId)).toEqual(['A016'])
    const page = await mod.searchCachedCatalog({ limit: 2 })
    expect(page).toMatchObject({ count: 2, total: 3, truncated: true })
    expect(page.atomics.map((r) => r.itemId)).toEqual(['B002', 'A016'])
    expect(Object.keys(page.atomics[0]).sort()).toEqual(Object.keys(CATALOG.rows[0]).sort()) // no `position` leaks into a row
    expect(await mod.cachedCatalogRows(['W142', 'nope'])).toEqual(new Map([['W142', CATALOG.rows[2]]]))
  })
})

// ─── The price sheet and the labelled Preview (U3; Kyle, 2026-10-13: every difficulty) ───────

/** The sheet's words for a difficulty the book does not publish for the item — a sentence with no number in it. */
const NO_DIFFICULTY_WORDS = 'No price is published for this item at this difficulty — the office prices it'
const NO_LABOUR_WORDS = 'No labour figure is published for this item at this difficulty — the office prices it'
const priced = { NORMAL: null, DIFFICULT: null, VERY_DIFFICULT: null }

/** What the office cuts: ONE customer price per live item at EACH difficulty, or null with words there. Never a labour figure. */
const SHEET = {
  version: 's1',
  generatedAt: '2026-10-09T13:05:00.000Z',
  supplierId: 'HD',
  tripCharge: 0,
  rateProvisional: false,
  rows: [
    { itemId: 'A016', price: { NORMAL: 60.25, DIFFICULT: 75, VERY_DIFFICULT: 90 }, gap: priced, exactOffline: true },
    // Kyle's row with only the Normal column filled: Difficult and Very difficult are null WITH words, never Normal standing in.
    { itemId: 'B002', price: { NORMAL: 80, DIFFICULT: null, VERY_DIFFICULT: null }, gap: { NORMAL: null, DIFFICULT: NO_DIFFICULTY_WORDS, VERY_DIFFICULT: NO_DIFFICULTY_WORDS }, exactOffline: true },
    { itemId: 'W142', price: { NORMAL: 2.5, DIFFICULT: 3, VERY_DIFFICULT: 3.5 }, gap: priced, exactOffline: false },
    { itemId: 'NOHRS', price: { NORMAL: null, DIFFICULT: null, VERY_DIFFICULT: null }, gap: { NORMAL: NO_LABOUR_WORDS, DIFFICULT: NO_LABOUR_WORDS, VERY_DIFFICULT: NO_LABOUR_WORDS }, exactOffline: false },
  ],
}

describe('the saved price sheet (meta row)', () => {
  it('saves the whole sheet in one row with when it was saved, skips an unchanged version, and keeps the saved sheet when the office cannot be reached', async () => {
    let sheet = SHEET
    const server = mockServer((c) => {
      if (c.path.startsWith('/quote-price-sheet')) {
        const version = new URL(`https://x${c.path}`).searchParams.get('version')
        return version === sheet.version ? { status: 200, data: { unchanged: true, version } } : { status: 200, data: sheet }
      }
      return { status: 500 }
    })
    expect(await mod.cachedPriceSheet()).toBeNull()
    const first = await mod.syncPriceSheet()
    expect(first).toMatchObject({ stale: false, unchanged: false, sheet: { version: 's1', supplierId: 'HD', tripCharge: 0, rateProvisional: false } })
    expect(first.sheet!.rows).toEqual(SHEET.rows)
    expect(first.sheet!.cachedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(server.calls[0].path).toBe('/quote-price-sheet')

    const second = await mod.syncPriceSheet()
    expect(second).toMatchObject({ stale: false, unchanged: true, sheet: { version: 's1' } })
    expect(server.calls[1].path).toBe('/quote-price-sheet?version=s1')

    sheet = { ...SHEET, version: 's2', rows: SHEET.rows.filter((r) => r.itemId !== 'W142') }
    const third = await mod.syncPriceSheet()
    expect(third.sheet).toMatchObject({ version: 's2' })
    expect((await mod.cachedPriceSheet())!.rows.map((r) => r.itemId)).toEqual(['A016', 'B002', 'NOHRS'])

    deadNetwork()
    expect(await mod.syncPriceSheet()).toMatchObject({ stale: true, unchanged: false, sheet: { version: 's2' }, error: 'Failed to fetch' })
    expect((await mod.cachedPriceSheet())!.version).toBe('s2')

    await mod.forgetPriceSheet()
    expect(await mod.cachedPriceSheet()).toBeNull()
  })

  it('a saved sheet never carries a labour figure, a cost, a tier or a rate — three customer prices per row, and a gap is words with no number in them', async () => {
    mockServer(() => ({ status: 200, data: SHEET }))
    await mod.syncPriceSheet()
    const saved = (await mod.cachedPriceSheet())!
    const text = JSON.stringify(saved)
    for (const banned of ['laborNormal', 'laborDifficult', 'laborHours', 'laborDollars', 'laborUnitBasis', 'companyCost', 'companyPrice', 'costBasis', 'sellPricePerUnit', 'sellNormal', 'markupTier', 'discountRatePct']) {
      expect(text, banned).not.toContain(banned)
    }
    for (const row of saved.rows) {
      expect(Object.keys(row).sort()).toEqual(['exactOffline', 'gap', 'itemId', 'price'])
      expect(Object.keys(row.price)).toEqual(['NORMAL', 'DIFFICULT', 'VERY_DIFFICULT'])
      expect(Object.keys(row.gap)).toEqual(['NORMAL', 'DIFFICULT', 'VERY_DIFFICULT'])
      for (const words of Object.values(row.gap)) if (words !== null) expect(words).not.toMatch(/\d/)
    }
  })

  it('a Normal-only sheet saved by an earlier build (2026-10-09) is not read: it counts as no sheet, and the next sync fetches the whole current one', async () => {
    const { QUOTE_PRICE_SHEET_META_KEY } = await import('../db/database')
    await db.meta.put({
      key: QUOTE_PRICE_SHEET_META_KEY,
      value: { ...SHEET, version: 'old-normal-only', rows: [{ itemId: 'A016', price: { NORMAL: 60.25 }, gap: null, exactOffline: true }], cachedAt: '2026-10-09T13:06:00.000Z' },
      updatedAt: 'then',
    })
    expect(await mod.cachedPriceSheet()).toBeNull()
    // With "no sheet", a touched line is "priced when signal returns" — never a figure read off a shape that lacks its difficulty.
    const view = mod.overlayQuote(mirrorOf(serverQuote()), [
      { opId: 'op-1', draftId: D1, visitId: 'v1', seq: 1, kind: 'edit_line', body: { kind: 'edit_line', lineId: 'line-1', patch: { difficulty: 'DIFFICULT' } }, status: 'queued', attempts: 0, queuedAt: 'now' },
    ], new Map(), await mod.cachedPriceSheet())
    expect(view).toMatchObject({ priceSource: 'none', total: null })
    expect(view.lines[0]).toMatchObject({ lineTotal: null, priceReason: 'Priced when signal returns' })

    const { calls } = mockServer(() => ({ status: 200, data: SHEET }))
    const synced = await mod.syncPriceSheet()
    expect(calls[0].path).toBe('/quote-price-sheet') // no version sent: the old one is not vouched for
    expect(synced.sheet?.version).toBe('s1')
    expect((await mod.cachedPriceSheet())?.rows.map((r) => Object.keys(r.price))).toEqual(SHEET.rows.map(() => ['NORMAL', 'DIFFICULT', 'VERY_DIFFICULT']))
  })
})

describe('the overlay with a price sheet: every figure is a labelled Preview from the sheet, never mixed with the office\'s', () => {
  const catalog = new Map(CATALOG.rows.map((r) => [r.itemId, r]))
  const op = (seq: number, body: QuoteOpRecord['body'], status: QuoteOpRecord['status'] = 'queued'): QuoteOpRecord => ({
    opId: `op-${seq}`, draftId: D1, visitId: 'v1', seq, kind: body.kind, body, status, attempts: 0, queuedAt: 'now',
  })
  const cached = { ...SHEET, cachedAt: '2026-10-09T13:06:00.000Z' }

  it('with nothing waiting the office\'s figures stand, sheet or no sheet', () => {
    const view = mod.overlayQuote(mirrorOf(serverQuote()), [], catalog, cached)
    expect(view.priceSource).toBe('server')
    expect(view.total).toBe(200.5)
    expect(view.lines.map((l) => l.lineTotal)).toEqual([120.5, 80])
    expect(view.money).toEqual(serverQuote().money)
    expect(view).toMatchObject({ previewReason: null, previewOptions: null, priceSheetAt: null })
  })

  it('a touched quote is previewed whole: untouched lines too, the office\'s figures gone, the trip and discount from the shared pricer, no financing', () => {
    const view = mod.overlayQuote(mirrorOf(serverQuote()), [
      op(1, { kind: 'edit_line', lineId: 'line-1', patch: { quantity: 3 }, expected: { quantity: 2 } }),
      op(2, { kind: 'add_line', lineId: L1, itemId: 'W142', quantity: 40, option: 'B' }),
    ], catalog, cached)
    expect(view).toMatchObject({ touched: true, priceSource: 'preview', previewReason: null, priceSheetAt: '2026-10-09T13:06:00.000Z' })
    const [l1, l2, added] = view.lines
    // line-1: 3 × 60.25 — the office's 120.5 (for 2) is gone, not kept, not added to.
    expect(l1).toMatchObject({ id: 'line-1', quantity: 3, lineTotal: 180.75, pendingPrice: false, priceStatus: 'preview', priceReason: null })
    // line-2 was NOT touched, and still comes from the sheet (1 × 80), not from the office's payload.
    expect(l2).toMatchObject({ id: 'line-2', lineTotal: 80, pendingPrice: false, priceStatus: 'preview' })
    // Wire: 40 × 2.5, badged "may come down".
    expect(added).toMatchObject({ id: L1, lineTotal: 100, pendingPrice: false, priceStatus: 'mayComeDown' })
    expect(added.priceReason).toMatch(/may come down once issued/i)
    expect(view.options).toEqual([
      { option: 'A', lineCount: 2, subtotal: 260.75, complete: true },
      { option: 'B', lineCount: 1, subtotal: 100, complete: true },
    ])
    expect(view.previewOptions).toEqual([
      { option: 'A', subtotal: 260.75, mayComeDown: false, unpriced: false },
      { option: 'B', subtotal: 100, mayComeDown: true, unpriced: false },
    ])
    // The whole-job headline, and the selection table from the SAME shared pricer the office uses.
    expect(view.total).toBe(360.75)
    expect(Object.keys(view.money.selections).sort()).toEqual(['A', 'A+B', 'B'])
    expect(view.money.selections['A+B']).toMatchObject({ subtotal: 360.75, trip: 0, comboSaving: 0, base: 360.75, discount: 18.04, discountCapped: false, total: 342.71 })
    // The office's military programme (words) applied by the shared builder — its rows are preview dollars.
    expect(view.money.discount).toMatchObject({ type: 'military', percent: 5, label: 'Military discount (5%)', terms: '5% off, capped at $250', pricedOnceComplete: false })
    expect(view.money.discount!.rows).toEqual([{ label: 'whole job', base: 360.75, comboSaving: 0, amount: 18.04, capped: false, after: 342.71 }])
    expect(view.money.discountedTotal).toBe(342.71)
    expect(view.money.financing).toBeNull()
    expect(view.money.pickable).toEqual(['A', 'B'])
    // Nothing the office sent for the OLD lines survives: 120.5, 200.5, 190.47 and 10.03 are gone.
    const shown = numbersIn({ total: view.total, options: view.options, selections: view.money.selections, lines: view.lines.map((l) => l.lineTotal), money: view.money })
    for (const stale of [120.5, 200.5, 190.47, 10.03]) expect(shown.has(stale), String(stale)).toBe(false)
  })

  it('a discount waiting to reach the office is the programme the preview applies; a trip on the sheet rides into every selection', () => {
    const view = mod.overlayQuote(mirrorOf(serverQuote()), [
      op(1, { kind: 'set_discount', type: 'custom', percent: 10 }),
    ], catalog, { ...cached, tripCharge: 25 })
    expect(view.pendingDiscount).toEqual({ type: 'custom', percent: 10 })
    expect(view.money.discount).toMatchObject({ type: 'custom', percent: 10, label: 'Discount (10%)', terms: '10% off, no cap' })
    // A: 2 × 60.25 + 1 × 80 = 200.5, plus the sheet's trip 25 = 225.5 base; 10% = 22.55.
    expect(view.money.selections.A).toMatchObject({ subtotal: 200.5, trip: 25, base: 225.5, discount: 22.55, total: 202.95 })
    expect(view.total).toBe(225.5)

    const none = mod.overlayQuote(mirrorOf(serverQuote()), [op(1, { kind: 'set_discount', type: null, percent: null })], catalog, cached)
    expect(none.money.discount).toBeNull()
    expect(none.money.selections.A).toMatchObject({ discount: 0, total: 200.5 })
  })

  it('a Difficult and a Very difficult line preview at THEIR OWN price from the sheet (Kyle, 2026-10-13) — never the Normal figure, a ceiling or a discount', () => {
    const view = mod.overlayQuote(mirrorOf(serverQuote()), [
      op(1, { kind: 'edit_line', lineId: 'line-1', patch: { difficulty: 'DIFFICULT' } }),
      op(2, { kind: 'add_line', lineId: L1, itemId: 'A016', quantity: 3, option: 'A', difficulty: 'VERY_DIFFICULT' }),
      op(3, { kind: 'add_line', lineId: L2, itemId: 'W142', quantity: 40, option: 'B', difficulty: 'VERY_DIFFICULT' }),
    ], catalog, cached)
    expect(view.priceSource).toBe('preview')
    const [l1, l2, vd, wire] = view.lines
    expect(l1).toMatchObject({ id: 'line-1', difficulty: 'DIFFICULT', lineTotal: 150, pendingPrice: false, priceStatus: 'preview', priceReason: null }) // 2 × 75, not 2 × 60.25
    expect(l2).toMatchObject({ id: 'line-2', lineTotal: 80, priceStatus: 'preview' })
    expect(vd).toMatchObject({ id: L1, difficulty: 'VERY_DIFFICULT', lineTotal: 270, priceStatus: 'preview' }) // 3 × 90
    expect(wire).toMatchObject({ id: L2, lineTotal: 140, priceStatus: 'mayComeDown' }) // 40 × 3.5 at Very difficult
    expect(view.options).toEqual([
      { option: 'A', lineCount: 3, subtotal: 500, complete: true },
      { option: 'B', lineCount: 1, subtotal: 140, complete: true },
    ])
    expect(view.total).toBe(640)
    // Nothing on screen is a Normal figure for those lines.
    const shown = numbersIn({ lines: view.lines.map((l) => l.lineTotal), options: view.options, total: view.total })
    for (const normal of [120.5, 180.75, 100]) expect(shown.has(normal), String(normal)).toBe(false)
  })

  it('a difficulty the sheet has no price for, an item with no price on the sheet and an item not on the sheet read "priced when signal returns" with the sheet\'s own words; their option and every selection holding it show no figure', () => {
    const view = mod.overlayQuote(mirrorOf(serverQuote()), [
      op(1, { kind: 'edit_line', lineId: 'line-2', patch: { difficulty: 'DIFFICULT' } }),
      op(2, { kind: 'add_line', lineId: L1, itemId: 'NOHRS', quantity: 1, option: 'B' }),
      op(3, { kind: 'add_line', lineId: L2, itemId: 'ZZ99', quantity: 1, option: 'C' }),
    ], catalog, cached)
    expect(view.priceSource).toBe('preview')
    const [l1, l2, nohrs, unknown] = view.lines
    expect(l1).toMatchObject({ id: 'line-1', lineTotal: 120.5, priceStatus: 'preview' })
    // B002 at Difficult: the book publishes no Difficult column for it — the sheet's words for THAT difficulty, and no figure.
    expect(l2).toMatchObject({ id: 'line-2', difficulty: 'DIFFICULT', lineTotal: null, pendingPrice: true, priceStatus: 'unpriced', priceReason: NO_DIFFICULTY_WORDS })
    expect(nohrs).toMatchObject({ lineTotal: null, priceStatus: 'unpriced', priceReason: NO_LABOUR_WORDS })
    expect(unknown).toMatchObject({ lineTotal: null, priceStatus: 'unpriced' })
    expect(unknown.priceReason).toMatch(/Not in the prices saved on this phone/)
    expect(view.options).toEqual([
      { option: 'A', lineCount: 2, subtotal: null, complete: false },
      { option: 'B', lineCount: 1, subtotal: null, complete: false },
      { option: 'C', lineCount: 1, subtotal: null, complete: false },
    ])
    expect(view.previewOptions!.map((o) => [o.option, o.unpriced])).toEqual([['A', true], ['B', true], ['C', true]])
    expect(view.total).toBeNull()
    expect(view.money.selections).toEqual({})
    expect(view.money.discount).toMatchObject({ rows: [], pricedOnceComplete: true })
    expect(view.money.discountedTotal).toBeNull()
  })

  it('the whole quote is unpriced when the office\'s rate is provisional or the quote prices at another supplier than the sheet', () => {
    const edit = [op(1, { kind: 'edit_line', lineId: 'line-1', patch: { quantity: 3 } })]
    const provisional = mod.overlayQuote(mirrorOf(serverQuote()), edit, catalog, { ...cached, rateProvisional: true })
    expect(provisional.priceSource).toBe('preview')
    expect(provisional.previewReason).toMatch(/labour rate needs checking/)
    expect(provisional.lines.every((l) => l.lineTotal === null && l.priceStatus === 'unpriced' && l.priceReason === provisional.previewReason)).toBe(true)
    expect(provisional.total).toBeNull()

    const other = mod.overlayQuote(mirrorOf({ ...serverQuote(), supplierId: 'LOWES' }), edit, catalog, cached)
    expect(other.previewReason).toMatch(/different supplier/)
    expect(other.lines.every((l) => l.lineTotal === null)).toBe(true)

    // A phone-only quote names no supplier yet, so the sheet's supplier is taken as read.
    const phoneOnly = mod.overlayQuote(null, [op(1, { kind: 'start_quote', title: 'New' }), op(2, { kind: 'add_line', lineId: L1, itemId: 'B002', quantity: 2 })], catalog, cached)
    expect(phoneOnly).toMatchObject({ previewReason: null, total: 160 })
    expect(phoneOnly.lines[0]).toMatchObject({ lineTotal: 160, priceStatus: 'preview' })
  })

  it('an AI-proposed line is not previewed, as the office does not price it', () => {
    const withProposal: QuoteState = { ...serverQuote(), lines: [...serverQuote().lines, { id: 'line-3', itemId: 'A016', description: 'Single-pole switch', quantity: 5, quantitySource: 'COUNT', difficulty: 'NORMAL', option: 'A', note: null, location: null, lineTotal: null, gaps: [], state: 'PROPOSED' }] }
    const view = mod.overlayQuote(mirrorOf(withProposal), [op(1, { kind: 'edit_line', lineId: 'line-2', patch: { quantity: 2 } })], catalog, cached)
    expect(view.lines[2]).toMatchObject({ id: 'line-3', lineTotal: null, pendingPrice: false, priceStatus: 'office' })
    // A: 2 × 60.25 + 2 × 80 — the proposal's 5 switches are not in it.
    expect(view.options).toEqual([{ option: 'A', lineCount: 3, subtotal: 280.5, complete: true }])
  })

  it('loadQuoteView hands the saved sheet to the overlay; with no sheet saved, a touched line reads "priced when signal returns"', async () => {
    await db.quoteMirrors.put(mirrorOf(serverQuote()))
    await offlineWhile(() => mod.enqueueQuoteOp({ draftId: D1, visitId: 'v1', body: { kind: 'edit_line', lineId: 'line-1', patch: { quantity: 3 }, expected: { quantity: 2 } } }))
    const bare = await mod.loadQuoteView(D1)
    expect(bare).toMatchObject({ priceSource: 'none', total: null })
    expect(bare.lines[0]).toMatchObject({ lineTotal: null, priceReason: 'Priced when signal returns' })

    mockServer(() => ({ status: 200, data: SHEET }))
    await mod.syncPriceSheet()
    const previewed = await mod.loadQuoteView(D1)
    expect(previewed).toMatchObject({ priceSource: 'preview', total: 260.75 })
    expect(previewed.lines[0]).toMatchObject({ lineTotal: 180.75, priceStatus: 'preview' })
    expect(previewed.priceSheetAt).toBe((await mod.cachedPriceSheet())!.cachedAt)
  })
})

describe('wiring', () => {
  it('registerQuoteSyncListener re-flushes on the browser online event', () => {
    mod.registerQuoteSyncListener()
    expect((window.addEventListener as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('online')
  })

  it('persistent storage is asked for once, the first time something is queued — not when the browser already has it, never at app start', async () => {
    const storage = { persisted: vi.fn().mockResolvedValue(false), persist: vi.fn().mockResolvedValue(true) }
    vi.stubGlobal('navigator', { onLine: false, storage })
    expect(storage.persist).not.toHaveBeenCalled()
    await mod.enqueueQuoteOp({ draftId: D1, visitId: 'v1', body: { kind: 'add_line', lineId: L1, itemId: 'B002', quantity: 1 } })
    await mod.enqueueQuoteOp({ draftId: D1, visitId: 'v1', body: { kind: 'add_line', lineId: L2, itemId: 'A016', quantity: 1 } })
    await mod.requestPersistentStorage()
    expect(storage.persisted).toHaveBeenCalledTimes(1)
    expect(storage.persist).toHaveBeenCalledTimes(1)

    vi.resetModules()
    const fresh = await import('./quoteSync')
    const already = { persisted: vi.fn().mockResolvedValue(true), persist: vi.fn().mockResolvedValue(true) }
    vi.stubGlobal('navigator', { onLine: false, storage: already })
    await fresh.requestPersistentStorage()
    expect(already.persist).not.toHaveBeenCalled()

    // No API at all (an older browser): nothing thrown, nothing asked.
    vi.stubGlobal('navigator', { onLine: false })
    vi.resetModules()
    await expect((await import('./quoteSync')).requestPersistentStorage()).resolves.toBeUndefined()
  })

  it('isNetworkFailure: only what fetch itself threw is offline (D7); a server refusal, no session, or a bug in this phone\'s code never is', () => {
    expect(crmSync.isNetworkFailure(new crmSync.CrmNetworkError(new TypeError('Failed to fetch')))).toBe(true)
    expect(crmSync.isNetworkFailure(new crmSync.CrmNetworkError(new DOMException('The operation was aborted.', 'AbortError')))).toBe(true)
    expect(crmSync.isNetworkFailure(new crmSync.CrmRequestError('no', { success: false }, 409))).toBe(false)
    expect(crmSync.isNetworkFailure(new Error('CRM not configured'))).toBe(false)
    // A TypeError that did not come out of fetch is a code bug, not a dead network.
    expect(crmSync.isNetworkFailure(new TypeError("Cannot read properties of undefined (reading 'lines')"))).toBe(false)
    expect(crmSync.isNetworkFailure(new TypeError('Failed to fetch'))).toBe(false)
    // The wrapper keeps the browser's own words and the cause.
    const wrapped = new crmSync.CrmNetworkError(new TypeError('Failed to fetch'))
    expect(wrapped.message).toBe('Failed to fetch')
    expect(wrapped.name).toBe('CrmNetworkError')
    expect(wrapped.cause).toBeInstanceOf(TypeError)
  })

  it('a dead network on a quote write is classified as no signal through the wrapper (D7): the edit waits "for signal", and a code bug does not', async () => {
    deadNetwork()
    const { start } = await offlineWhile(() => queueStartAndLine())
    await mod.awaitOp(start.opId)
    expect((await ops(D1))[0]).toMatchObject({ status: 'queued', attempts: 1, lastError: 'Failed to fetch', lastErrorKind: 'network' })

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
    const fetchSpy = deadNetwork()
    await mod.flushQuoteQueue()
    expect(fetchSpy).not.toHaveBeenCalled()
    const row = (await ops(D1))[0]
    expect(row).toMatchObject({ status: 'queued', attempts: 2, lastErrorKind: 'phone' })
    expect(row.lastError).toMatch(/Cannot read properties/)
  })
})

// ─── U5 (2026-10-10): the Quote screen's one write path ──────────────────────────────────────
//
// Every write the screen makes — online and offline alike — goes through writeQuote: to the phone
// first, then sent at once through the same id-carrying route with `expected`. What is proved: a
// live write lands and the screen gets the office's fresh copy with nothing left waiting and nothing
// flagged for review; a live refusal is thrown to the control in the office's own words and does NOT
// sit in the queue blocking the draft; no answer means queued (and the screen is told it is offline);
// an edit behind a refused one waits for the tech, unsent.

describe("writeQuote — the Quote screen's one write path (U5)", () => {
  const edit = { kind: 'edit_line' as const, lineId: 'line-1', patch: { quantity: 4 }, expected: { quantity: 2 } }

  it('with signal and nothing waiting: sent at once with the id and `expected`, delivered, the saved copy refreshed from the office and NOT flagged for review, nothing left in the queue', async () => {
    await db.quoteMirrors.put(mirrorOf(serverQuote()))
    const fresh = serverQuote()
    fresh.lines[0].quantity = 4
    fresh.lines[0].lineTotal = 241
    const server = mockServer((c) => (c.method === 'GET' && c.path === `/quotes/${D1}` ? { status: 200, data: fresh } : { status: 200, data: { lineId: L1 } }))

    expect((await mod.writeQuote({ draftId: D1, visitId: 'v1', body: edit })).state).toBe('delivered')
    expect(server.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['PATCH /quote-lines/line-1', `GET /quotes/${D1}`])
    expect(server.calls[0].body).toEqual({ quantity: 4, expected: { quantity: 2 } })
    expect(await ops(D1)).toEqual([])
    const mirror = await mod.quoteMirror(D1)
    expect(mirror).toMatchObject({ origin: 'server', visitId: 'v1', pricesNeedReview: false })
    expect(mirror!.payload.lines[0].lineTotal).toBe(241)
    const view = await mod.loadQuoteView(D1)
    expect(view.priceSource).toBe('server')
    expect(view.lines[0]).toMatchObject({ quantity: 4, lineTotal: 241 })

    // An add carries the id this phone minted: the replay-safe PUT, never the POST.
    expect((await mod.writeQuote({ draftId: D1, visitId: 'v1', body: { kind: 'add_line', lineId: L1, itemId: 'B002', quantity: 1, option: 'B' } })).state).toBe('delivered')
    expect(server.calls[2]).toMatchObject({ method: 'PUT', path: `/quotes/${D1}/lines/${L1}`, body: { itemId: 'B002', quantity: 1, option: 'B' } })
  })

  it("a live refusal is thrown to the control in the office's own words with its status, and the edit is taken OUT of the queue — the next write is not blocked", async () => {
    await db.quoteMirrors.put(mirrorOf(serverQuote()))
    mockServer((c) => (c.method === 'PATCH'
      ? { status: 409, error: { code: 'conflict', message: 'Changed at the office since you last saw it: quantity was 2, now 5' } }
      : { status: 200, data: serverQuote() }))
    let caught: unknown
    try { await mod.writeQuote({ draftId: D1, visitId: 'v1', body: edit }) } catch (err) { caught = err }
    expect(caught).toBeInstanceOf(crmSync.CrmRequestError)
    expect((caught as Error).message).toBe('Changed at the office since you last saw it: quantity was 2, now 5')
    expect((caught as { status?: number }).status).toBe(409)
    expect(await ops(D1)).toEqual([])
    expect((await mod.loadQuoteView(D1)).lines[0].quantity).toBe(2)

    expect((await mod.writeQuote({ draftId: D1, visitId: 'v1', body: { kind: 'set_mode', exclusive: true, expected: { exclusive: false } } })).state).toBe('delivered')
  })

  it('no answer (fetch threw): queued, and the screen is told it is offline; the edit is laid over the saved copy; the next flush with signal delivers it', async () => {
    await db.quoteMirrors.put(mirrorOf(serverQuote()))
    deadNetwork()
    const outcome = await mod.writeQuote({ draftId: D1, visitId: 'v1', body: edit })
    expect(outcome).toMatchObject({ state: 'queued', offline: true })
    const view = await mod.loadQuoteView(D1)
    expect(view.priceSource).toBe('none')
    expect(view.lines[0]).toMatchObject({ quantity: 4, lineTotal: null, pendingPrice: true })
    expect(view.waiting).toHaveLength(1)

    const server = mockServer((c) => ({ status: 200, data: c.method === 'GET' ? serverQuote() : {} }))
    await mod.flushQuoteQueue()
    expect(server.calls[0]).toMatchObject({ method: 'PATCH', path: '/quote-lines/line-1', body: { quantity: 4, expected: { quantity: 2 } } })
    expect(await ops(D1)).toEqual([])
    // Delivered in the background, with the office's prices not yet looked at: flagged for U6's check.
    expect((await mod.quoteMirror(D1))?.pricesNeedReview).toBe(true)
  })

  it('behind an earlier edit the office refused, a new write is queued and NOT sent — the tech decides on the refusal first', async () => {
    await db.quoteMirrors.put(mirrorOf(serverQuote()))
    const server = mockServer((c) => (c.method === 'PATCH'
      ? { status: 409, error: { code: 'conflict', message: 'Changed at the office since you last saw it: quantity was 2, now 5' } }
      : { status: 200, data: serverQuote() }))
    const first = await offlineWhile(() => mod.enqueueQuoteOp({ draftId: D1, visitId: 'v1', body: edit }))
    await mod.flushQuoteQueue()
    expect((await mod.quoteOpOutcome(first.opId)).state).toBe('refused')
    const sent = server.calls.length

    const outcome = await mod.writeQuote({ draftId: D1, visitId: 'v1', body: { kind: 'set_mode', exclusive: true, expected: { exclusive: false } } })
    expect(outcome).toMatchObject({ state: 'queued', offline: false })
    expect(outcome.state === 'queued' ? outcome.reason : '').toMatch(/refused/)
    expect(server.calls.length).toBe(sent)
    expect((await ops(D1)).map((o) => o.status)).toEqual(['refused', 'queued'])
  })

  it('onQuoteSyncSettled fires when a pass settles and stops after unsubscribe; pendingQuoteOpCountForVisit counts every draft on the visit', async () => {
    const seen: number[] = []
    const off = mod.onQuoteSyncSettled(() => seen.push(1))
    await offlineWhile(async () => {
      await mod.enqueueQuoteOp({ draftId: D1, visitId: 'v1', body: { kind: 'add_line', lineId: L1, itemId: 'B002', quantity: 1 } })
      await mod.enqueueQuoteOp({ draftId: D2, visitId: 'v1', body: { kind: 'add_line', lineId: L2, itemId: 'B002', quantity: 1 } })
      await mod.enqueueQuoteOp({ draftId: '33333333-3333-4333-8333-333333333333', visitId: 'v2', body: { kind: 'set_mode', exclusive: true } })
    })
    expect(seen.length).toBeGreaterThan(0)
    expect(await mod.pendingQuoteOpCountForVisit('v1')).toBe(2)
    expect(await mod.pendingQuoteOpCountForVisit('v2')).toBe(1)
    expect(await mod.pendingQuoteOpCountForVisit('v3')).toBe(0)
    const before = seen.length
    off()
    deadNetwork()
    await mod.flushQuoteQueue()
    expect(seen.length).toBe(before)
  })

  it('workingQuoteMirrorForVisit: the newest saved copy for the visit that is not a change order — what "Build the quote" opens with no signal', async () => {
    const changeOrder = serverQuote(D2)
    changeOrder.isChangeOrder = true
    await db.quoteMirrors.put(mirrorOf(serverQuote(D1), { snapshotAt: '2026-10-09T10:00:00.000Z' }))
    await db.quoteMirrors.put(mirrorOf(changeOrder, { snapshotAt: '2026-10-09T12:00:00.000Z' }))
    await db.quoteMirrors.put(mirrorOf(serverQuote('44444444-4444-4444-8444-444444444444'), { snapshotAt: '2026-10-08T10:00:00.000Z' }))
    expect((await mod.workingQuoteMirrorForVisit('v1'))?.draftId).toBe(D1)
    expect(await mod.workingQuoteMirrorForVisit('nope')).toBeUndefined()
  })

  it("expectedFor*: read off the quote AS SHOWN — a discount change waiting on the phone wins over the office's, and the percent rides only for a custom programme", () => {
    const view = mod.overlayQuote(mirrorOf(serverQuote()), [])
    expect(mod.expectedForDiscount(view)).toEqual({ type: 'military', percent: null })
    expect(mod.expectedForDiscount({ ...view, pendingDiscount: { type: 'custom', percent: 7.5 } })).toEqual({ type: 'custom', percent: 7.5 })
    expect(mod.expectedForDiscount({ ...view, pendingDiscount: { type: null, percent: null } })).toEqual({ type: null, percent: null })
    expect(mod.expectedForDiscount({ ...view, money: { ...view.money, discount: null } })).toEqual({ type: null, percent: null })
    expect(mod.expectedForMode(view)).toEqual({ exclusive: false })
    expect(mod.expectedForDetails(view)).toEqual({ title: 'Hollis — 605 Green Farm Way', jobDescription: 'Replace the panel.' })
    expect(mod.expectedForOptionMeta(view, 'B')).toEqual({ label: null, note: null })
    expect(mod.expectedForOptionMeta(view, 'H')).toEqual({ label: null, note: null })
  })
})

describe('forgetQuoteMirror — the office deleted the quote', () => {
  it('drops the saved copy (and its finished rows) so "Build the quote" cannot open a dead quote with no signal; refused while an edit still waits', async () => {
    await db.quoteMirrors.put(mirrorOf(serverQuote()))
    const waiting = await offlineWhile(() => mod.enqueueQuoteOp({ draftId: D1, visitId: 'v1', body: { kind: 'set_mode', exclusive: true } }))
    await expect(mod.forgetQuoteMirror(D1)).rejects.toThrow('discard them first')
    expect(await mod.quoteMirror(D1)).toBeDefined()
    await mod.discardQuoteOp(waiting.opId)
    await mod.forgetQuoteMirror(D1)
    expect(await mod.quoteMirror(D1)).toBeUndefined()
    expect(await mod.workingQuoteMirrorForVisit('v1')).toBeUndefined()
  })
})

// ─── Phase 7 U6 (2026-10-10): after the sync ─────────────────────────────────────────────────────

describe('"Check the prices": what the phone showed is noted before the office\'s answer replaces it', () => {
  /** The price book and the price sheet as the Today screen saves them with signal. */
  const cacheSheet = async () => {
    const { QUOTE_PRICE_SHEET_META_KEY } = await import('../db/database')
    await db.meta.put({ key: QUOTE_PRICE_SHEET_META_KEY, value: { ...SHEET, cachedAt: '2026-10-10T12:00:00.000Z' }, updatedAt: 'now' })
    await db.quoteCatalog.bulkPut(CATALOG.rows.map((row, position) => ({ ...row, position })))
  }

  it('the first refresh after a delivery notes the figures AS SHOWN (the preview over the saved sheet); a later pass keeps that note; "I\'ve checked the prices" clears it with the gate', async () => {
    await cacheSheet()
    await db.quoteMirrors.put(mirrorOf(serverQuote()))
    // Two edits queued with no signal: line-1 to quantity 4 (preview 4 × $60.25 = $241.00) and a new line (3 × $80).
    const { edit, add } = await offlineWhile(async () => ({
      edit: await mod.enqueueQuoteOp({ draftId: D1, visitId: 'v1', body: { kind: 'edit_line', lineId: 'line-1', patch: { quantity: 4 }, expected: { quantity: 2 } } }),
      add: await mod.enqueueQuoteOp({ draftId: D1, visitId: 'v1', body: { kind: 'add_line', lineId: L1, itemId: 'B002', quantity: 3, option: 'B' } }),
    }))
    const shownOnPhone = await mod.loadQuoteView(D1)
    expect(shownOnPhone.priceSource).toBe('preview')
    expect(shownOnPhone.lines.map((l) => l.lineTotal)).toEqual([241, 80, 240])
    expect(shownOnPhone.total).toBe(561)

    // The office takes the first edit and is down (503) for the second: one pass delivers one edit.
    let addDown = true
    const office = serverQuote()
    office.lines[0].quantity = 4
    office.lines[0].lineTotal = 250
    office.options = [{ option: 'A', lineCount: 2, subtotal: 330, complete: true }]
    office.total = 330
    mockServer((c) => {
      if (c.method === 'PUT' && addDown) return { status: 503, error: { message: 'down' } }
      if (c.method === 'GET') return { status: 200, data: office }
      return { status: 200, data: {} }
    })
    await mod.flushQuoteQueue()
    expect(await db.quoteOpQueue.get(edit.opId)).toBeUndefined()
    expect(await db.quoteOpQueue.get(add.opId)).toMatchObject({ status: 'queued', attempts: 1 })
    const mirror1 = (await mod.quoteMirror(D1))!
    expect(mirror1.pricesNeedReview).toBe(true)
    expect(mirror1.shownBeforeSync).toMatchObject({
      source: 'preview',
      total: 561,
      lines: [{ id: 'line-1', description: 'Single-pole switch', total: 241 }, { id: 'line-2', description: 'Duplex receptacle', total: 80 }, { id: L1, description: 'Duplex receptacle', total: 240 }],
      options: [{ option: 'A', subtotal: 321 }, { option: 'B', subtotal: 240 }],
    })
    // Named fields only — never the queue, a cost or an hour.
    expect(Object.keys(mirror1.shownBeforeSync!).sort()).toEqual(['at', 'lines', 'options', 'source', 'total'])
    expect(Object.keys(mirror1.shownBeforeSync!.lines[0]).sort()).toEqual(['description', 'id', 'total'])

    // Pass two lands the add. The note stays the FIRST one — what the tech built against — not the half-way copy.
    addDown = false
    office.lines.push({ id: L1, itemId: 'B002', description: 'Duplex receptacle', quantity: 3, quantitySource: 'COUNT', difficulty: 'NORMAL', option: 'B', note: null, location: null, lineTotal: 239, gaps: [], retired: false })
    office.options = [{ option: 'A', lineCount: 2, subtotal: 330, complete: true }, { option: 'B', lineCount: 1, subtotal: 239, complete: true }]
    office.total = 569
    await mod.flushQuoteQueue()
    expect(await ops(D1)).toEqual([])
    const mirror2 = (await mod.quoteMirror(D1))!
    expect(mirror2.pricesNeedReview).toBe(true)
    expect(mirror2.shownBeforeSync).toEqual(mirror1.shownBeforeSync)

    // The view carries the note for the panel; the comparison is lib/priceCheck.ts, equality only, both figures.
    const view = await mod.loadQuoteView(D1)
    expect(view.priceSource).toBe('server')
    expect(view.shownBeforeSync).toEqual(mirror1.shownBeforeSync)
    const { priceCheck } = await import('./priceCheck')
    const report = priceCheck(view.shownBeforeSync, view)
    expect(report.rows.map((r) => r.kind)).toEqual(['changed', 'changed', 'option', 'option', 'total'])
    expect(report.rows[0].words).toBe('Single-pole switch: this phone showed $241.00, the office says $250.00')
    expect(report.rows[4].words).toBe('Total: this phone showed $561.00, the office says $569.00')
    // No arithmetic: none of the differences (9.00, 1.00, 8.00) is anywhere in the report.
    expect(report.rows.map((r) => r.words).join('\n')).not.toMatch(/\$9\.00|\$1\.00|\$8\.00/)

    // A plain refresh (the screen's own fetch) keeps the gate and the note.
    await crmSync.fetchQuote(D1, { visitId: 'v1' })
    expect(await mod.quoteMirror(D1)).toMatchObject({ pricesNeedReview: true, shownBeforeSync: mirror1.shownBeforeSync })

    await mod.markPricesReviewed(D1)
    expect(await mod.quoteMirror(D1)).toMatchObject({ pricesNeedReview: false, shownBeforeSync: null })
    expect((await mod.loadQuoteView(D1)).shownBeforeSync).toBeNull()
  })

  it('with no sheet saved the note says the phone showed no figure for a touched line, and the office\'s figure for it is "priced for the first time"', async () => {
    await db.quoteMirrors.put(mirrorOf(serverQuote()))
    await offlineWhile(() => mod.enqueueQuoteOp({ draftId: D1, visitId: 'v1', body: { kind: 'add_line', lineId: L1, itemId: 'B002', quantity: 1, option: 'A' } }))
    const office = serverQuote()
    office.lines.push({ id: L1, itemId: 'B002', description: 'Duplex receptacle', quantity: 1, quantitySource: 'COUNT', difficulty: 'NORMAL', option: 'A', note: null, location: null, lineTotal: 80, gaps: [], retired: false })
    mockServer((c) => ({ status: 200, data: c.method === 'GET' ? office : {} }))
    await mod.flushQuoteQueue()
    const mirror = (await mod.quoteMirror(D1))!
    expect(mirror.shownBeforeSync).toMatchObject({ source: 'none', total: null, lines: [{ id: 'line-1', total: 120.5 }, { id: 'line-2', total: 80 }, { id: L1, total: null }] })
    const { priceCheck } = await import('./priceCheck')
    const report = priceCheck(mirror.shownBeforeSync, mirror.payload)
    expect(report.rows).toEqual([{ kind: 'first', words: 'Duplex receptacle: priced for the first time — $80.00', shown: null, office: 80 }])
  })

  it('an online edit made while a review is owed does not clear the gate — only "I\'ve checked the prices" does', async () => {
    const owed = { at: '2026-10-10T12:00:00.000Z', source: 'none' as const, lines: [], options: [], total: null }
    await db.quoteMirrors.put(mirrorOf(serverQuote(), { pricesNeedReview: true, shownBeforeSync: owed }))
    mockServer((c) => ({ status: 200, data: c.method === 'GET' ? serverQuote() : {} }))
    const mode = { kind: 'set_mode' as const, exclusive: true, expected: { exclusive: false } }
    expect((await mod.writeQuote({ draftId: D1, visitId: 'v1', body: mode })).state).toBe('delivered')
    expect(await mod.quoteMirror(D1)).toMatchObject({ pricesNeedReview: true, shownBeforeSync: owed })

    await mod.markPricesReviewed(D1)
    // Nothing waiting and nothing owed: the tech watches the office's answer land, so no gate.
    expect((await mod.writeQuote({ draftId: D1, visitId: 'v1', body: mode })).state).toBe('delivered')
    expect(await mod.quoteMirror(D1)).toMatchObject({ pricesNeedReview: false, shownBeforeSync: null })
  })
})

describe('"Sign in again — N changes waiting"', () => {
  it('is set by a pass the office answered 401, left alone by a pass skipped for no signal, and cleared by a pass the office answers', async () => {
    expect(mod.quoteSyncNeedsSignIn()).toBe(false)
    mockServer(() => ({ status: 401, error: { code: 'unauthorized', message: 'Token revoked' } }))
    await offlineWhile(() => queueStartAndLine())
    expect(mod.quoteSyncNeedsSignIn()).toBe(false) // the no-signal passes tried nothing
    await mod.flushQuoteQueue()
    expect(mod.quoteSyncNeedsSignIn()).toBe(true)

    vi.stubGlobal('navigator', { onLine: false })
    await mod.flushQuoteQueue()
    expect(mod.quoteSyncNeedsSignIn()).toBe(true)
    vi.stubGlobal('navigator', { onLine: true })

    mockServer((c) => ({ status: 200, data: c.method === 'GET' ? serverQuote() : {} }))
    await mod.flushQuoteQueue()
    expect(mod.quoteSyncNeedsSignIn()).toBe(false)
    expect(await ops(D1)).toEqual([])
  })
})

describe('the office started one first: the three buttons (design §5)', () => {
  /** The phone's quote: a refused start (409 with the office's draft), a line, and two settings edits. */
  async function phoneQuoteBehindTheOffice() {
    await db.quoteMirrors.put(mirrorOf(mod.emptyQuoteState(D1), { origin: 'phone', pendingRebase: D2 }))
    const { start, add } = await queueStartAndLine()
    await db.quoteOpQueue.update(start.opId, { status: 'refused', existingDraftId: D2, refusal: 'The office already started a quote for this visit' })
    const discount = await mod.enqueueQuoteOp({ draftId: D1, visitId: 'v1', body: { kind: 'set_discount', type: 'senior', percent: null, expected: { type: null, percent: null } } })
    const mode = await mod.enqueueQuoteOp({ draftId: D1, visitId: 'v1', body: { kind: 'set_mode', exclusive: true, expected: { exclusive: false } } })
    return { start, add, discount, mode }
  }

  it('"Add my N lines to it" reads the office\'s quote (saving it here), moves the edits onto it — a ticked setting carrying the office\'s CURRENT value as expected, an unticked one dropped — and sends them', async () => {
    deadNetwork()
    const { add, discount, mode } = await phoneQuoteBehindTheOffice()
    const server = mockServer((c) => (c.method === 'GET' ? { status: 200, data: serverQuote(D2) } : { status: 200, data: {} }))

    const { moved, dropped } = await mod.applyRebase(D1, D2, 'v1', { applySettings: [discount.opId] })
    expect(moved.map((o) => [o.opId, o.draftId, o.status])).toEqual([[add.opId, D2, 'queued'], [discount.opId, D2, 'queued']])
    expect(dropped.map((o) => o.opId)).toEqual([mode.opId])
    // The office's draft carries a MILITARY discount: that is what the applied setting expects, never the phone's placeholder.
    expect(moved[1].body).toMatchObject({ kind: 'set_discount', type: 'senior', expected: { type: 'military', percent: null } })
    expect(server.calls[0]).toMatchObject({ method: 'GET', path: `/quotes/${D2}` })
    expect(await mod.quoteMirror(D1)).toBeUndefined()
    expect(await mod.quoteMirror(D2)).toMatchObject({ origin: 'server', visitId: 'v1', pendingRebase: null })

    // The kicked flush replays them onto the office's draft, in order, under the ids this phone minted.
    await mod.flushQuoteQueue()
    expect(server.calls.slice(1).map((c) => `${c.method} ${c.path}`)).toEqual([`PUT /quotes/${D2}/lines/${L1}`, `PUT /quotes/${D2}/discount`, `GET /quotes/${D2}`])
    expect(await ops(D1)).toEqual([])
    expect(await ops(D2)).toEqual([])
    expect((await mod.quoteMirror(D2))!.pricesNeedReview).toBe(true)
  })

  it('with no answer from the office nothing is moved: "needs signal" — a rebase against a stale copy would send expected values the office never held', async () => {
    deadNetwork()
    const { start, add, discount, mode } = await phoneQuoteBehindTheOffice()
    await expect(mod.applyRebase(D1, D2, 'v1', { applySettings: [discount.opId] })).rejects.toThrow(mod.REBASE_NEEDS_SIGNAL)
    expect((await ops(D1)).map((o) => o.opId)).toEqual([start.opId, add.opId, discount.opId, mode.opId])
    expect(await ops(D2)).toEqual([])
    expect((await mod.quoteMirror(D1))!.pendingRebase).toBe(D2)
  })

  it('"Discard them" drops the phone\'s quote with every edit on it ("Keep them on this phone for now" is the screen leaving everything exactly as it is)', async () => {
    deadNetwork()
    await phoneQuoteBehindTheOffice()
    expect(await mod.discardRebase(D1)).toEqual({ deleted: true, changes: 4 })
    expect(await ops(D1)).toEqual([])
    expect(await mod.quoteMirror(D1)).toBeUndefined()
  })
})

describe('"Discard all N waiting changes" after a refusal', () => {
  it('drops the refused edit and the ones queued behind it; the quote reads as the office has it and the next write goes straight through', async () => {
    await db.quoteMirrors.put(mirrorOf(serverQuote()))
    let refuse = true
    const server = mockServer((c) => (c.method === 'PATCH' && refuse
      ? { status: 409, error: { code: 'conflict', message: 'Changed at the office since you last saw it: quantity was 2, now 4' } }
      : { status: 200, data: c.method === 'GET' ? serverQuote() : {} }))
    const [first, second, third] = await offlineWhile(async () => [
      await mod.enqueueQuoteOp({ draftId: D1, visitId: 'v1', body: { kind: 'edit_line', lineId: 'line-1', patch: { quantity: 3 }, expected: { quantity: 2 } } }),
      await mod.enqueueQuoteOp({ draftId: D1, visitId: 'v1', body: { kind: 'add_line', lineId: L1, itemId: 'B002', quantity: 1 } }),
      await mod.enqueueQuoteOp({ draftId: D1, visitId: 'v1', body: { kind: 'add_line', lineId: L2, itemId: 'A016', quantity: 1 } }),
    ])
    await mod.flushQuoteQueue()
    expect((await ops(D1)).map((o) => o.status)).toEqual(['refused', 'queued', 'queued'])
    const view = await mod.loadQuoteView(D1)
    expect(view.refused.map((o) => o.opId)).toEqual([first.opId])
    expect(view.waiting.map((o) => o.opId)).toEqual([second.opId, third.opId])
    expect(view.refused[0].refusal).toBe('Changed at the office since you last saw it: quantity was 2, now 4')

    const { discarded } = await mod.discardAllQuoteOps(D1)
    expect(discarded.map((o) => o.opId)).toEqual([first.opId, second.opId, third.opId])
    expect(await mod.pendingQuoteOpCount(D1)).toBe(0)
    expect(await mod.loadQuoteView(D1)).toMatchObject({ touched: false, priceSource: 'server', refused: [], waiting: [] })

    refuse = false
    const sent = server.calls.length
    expect((await mod.writeQuote({ draftId: D1, visitId: 'v1', body: { kind: 'edit_line', lineId: 'line-1', patch: { quantity: 4 }, expected: { quantity: 2 } } })).state).toBe('delivered')
    expect(server.calls[sent]).toMatchObject({ method: 'PATCH', path: '/quote-lines/line-1', body: { quantity: 4, expected: { quantity: 2 } } })
  })
})
