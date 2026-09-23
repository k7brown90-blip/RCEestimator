/**
 * Adding a line to a P.O. from the field (2026-09-23 field-findability build, Unit A).
 *
 * `addPurchaseOrderLineFromField` posts to POST /purchase-orders/:id/lines. The server
 * (health-record.ts) defaults a missing `reason` to "added from the receipt at landing" — true
 * for LandPoForm's landing-time calls, a LIE for the new "Add an item" counter path on `PoRow`.
 * This pins: the counter path sends its own honest reason, and LandPoForm's existing calls
 * (which never passed a reason) keep sending no reason at all — so the server's landing-time
 * default keeps applying to them unchanged.
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

function lastCall(fetchMock: ReturnType<typeof vi.fn>) {
  const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [string, RequestInit]
  return { url, method: init.method, body: init.body ? (JSON.parse(String(init.body)) as unknown) : null }
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

describe('addPurchaseOrderLineFromField — the line, and whether a reason rides along', () => {
  it('the counter path ("Add an item" on PoRow) sends its own honest reason', async () => {
    const f = mockFetchOk({ id: 'line-1' })
    await crmSync.addPurchaseOrderLineFromField('po-1', {
      name: 'GFCI breaker 20A',
      qty: 3,
      unit: 'ea',
      unitCost: 24.5,
      reason: 'added at the counter',
    })
    expect(lastCall(f)).toEqual({
      url: 'https://rce.example.com/api/health-record/purchase-orders/po-1/lines',
      method: 'POST',
      body: { name: 'GFCI breaker 20A', qty: 3, unit: 'ea', unitCost: 24.5, reason: 'added at the counter' },
    })
  })

  it('LandPoForm\'s landing-time calls keep sending no reason at all — the server default still applies to them', async () => {
    const f = mockFetchOk({ id: 'line-2' })
    // Exactly the shape LandPoForm.tsx's addFromReceipt/addSuggested call today: no `reason` key.
    await crmSync.addPurchaseOrderLineFromField('po-1', { name: '12-2 NM-B', qty: 50, unit: 'ft', unitCost: 0.42 })
    const body = lastCall(f).body as Record<string, unknown>
    expect(body).toEqual({ name: '12-2 NM-B', qty: 50, unit: 'ft', unitCost: 0.42 })
    expect('reason' in body).toBe(false)
  })

  it('an item with no typed cost omits unitCost rather than sending a lying 0', async () => {
    const f = mockFetchOk({ id: 'line-3' })
    await crmSync.addPurchaseOrderLineFromField('po-1', { name: 'wire nuts', qty: 1, reason: 'added at the counter' })
    const body = lastCall(f).body as Record<string, unknown>
    expect(body).toEqual({ name: 'wire nuts', qty: 1, reason: 'added at the counter' })
    expect('unitCost' in body).toBe(false)
  })
})
