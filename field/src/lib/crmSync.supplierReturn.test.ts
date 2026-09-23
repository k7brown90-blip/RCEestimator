/**
 * Material going back to the store (2026-09-22), field side — Unit 4 of
 * .claude/plans/2026-09-22-supplier-returns.md.
 *
 * `supplierReturnFromField` posts to POST /my-truck/supplier-return, the
 * server route that resolves the truck from the logged-in tech (the body has
 * no location field at all — see health-record.ts). Pins: the exact body sent
 * (no location, optional purchaseOrderId defaults sensibly), and that a
 * server refusal (e.g. going below zero on hand) reaches the caller as the
 * server's own message, not an invented one — the same CrmRequestError
 * contract as every other field write (crmSync.requestError.test.ts).
 */

import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

function mockFetchOk(data: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 201, json: () => Promise.resolve({ success: true, data }) })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function mockFetchRefusal(body: unknown, status = 409) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status, json: () => Promise.resolve(body) }))
}

function lastCall(fetchMock: ReturnType<typeof vi.fn>) {
  const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [string, RequestInit]
  return { url, method: init.method, body: init.body ? JSON.parse(String(init.body)) as unknown : null }
}

let crmSync: typeof import('./crmSync')

beforeEach(async () => {
  stubBrowser()
  vi.resetModules()
  crmSync = await import('./crmSync')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('supplierReturnFromField — truck to the store', () => {
  it('posts itemId, qty and reason with no location field, and no P.O. named', async () => {
    const f = mockFetchOk({ id: 'mv1', qty: 100, unitCost: 0.42, name: '12-2 NM-B' })
    const r = await crmSync.supplierReturnFromField({ itemId: 'ITM-1', qty: 100, reason: 'Wrong gauge, taking it back' })
    expect(lastCall(f)).toEqual({
      url: 'https://rce.example.com/api/health-record/my-truck/supplier-return',
      method: 'POST',
      body: { itemId: 'ITM-1', qty: 100, reason: 'Wrong gauge, taking it back' },
    })
    expect(r).toEqual({ id: 'mv1', qty: 100, unitCost: 0.42, name: '12-2 NM-B' })
  })

  it('carries an optional purchaseOrderId through when the tech picks one', async () => {
    const f = mockFetchOk({ id: 'mv2', qty: 5, unitCost: 1.1, name: 'GFCI receptacle' })
    await crmSync.supplierReturnFromField({ itemId: 'ITM-2', qty: 5, reason: 'extra stock', purchaseOrderId: 'po-9' })
    expect(lastCall(f).body).toEqual({ itemId: 'ITM-2', qty: 5, reason: 'extra stock', purchaseOrderId: 'po-9' })
  })

  it('surfaces the server refusal message verbatim — never an invented client-side guess', async () => {
    mockFetchRefusal({
      success: false,
      error: { message: 'Only 80 ft of 12-2 NM-B on hand at that truck — 100 would go negative.' },
    })
    await expect(crmSync.supplierReturnFromField({ itemId: 'ITM-1', qty: 100, reason: 'too much' }))
      .rejects.toThrow('Only 80 ft of 12-2 NM-B on hand at that truck — 100 would go negative.')
  })

  it('the request never carries a location — the truck is resolved server-side, not chosen here', async () => {
    const f = mockFetchOk({ id: 'mv3', qty: 1, unitCost: 0, name: 'wire nuts' })
    await crmSync.supplierReturnFromField({ itemId: 'ITM-3', qty: 1, reason: 'x' })
    const body = lastCall(f).body as Record<string, unknown>
    expect(body.locationKey).toBeUndefined()
    expect(body.fromLocationKey).toBeUndefined()
    expect(body.truckId).toBeUndefined()
  })
})
