/**
 * The Quote screen's picker and line details (2026-10-08, one-estimating-system plan, Phase 2,
 * unit C): search, browse by section, and a line's location and note. Plain online calls like the
 * rest of the quote — no offline queue (that is Phase 7). These pin the request shapes.
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
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ success: true, data }) })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
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

describe('the price-book picker', () => {
  it('search: GETs the catalog with the typed words', async () => {
    const f = mockFetchOk({ atomics: [], count: 0, total: 0, truncated: false })
    await crmSync.searchQuoteCatalog('romex 14/2')
    expect(lastCall(f)).toEqual({ url: 'https://rce.example.com/api/health-record/quote-catalog?search=romex%2014%2F2', method: 'GET', body: null })
  })

  it('a section card: GETs the catalog by category, name encoded (an ampersand must not cut it short)', async () => {
    const f = mockFetchOk({ atomics: [], count: 0, total: 0, truncated: false })
    await crmSync.browseQuoteSection('SERVICE & FEES')
    expect(lastCall(f)).toEqual({ url: 'https://rce.example.com/api/health-record/quote-catalog?category=SERVICE%20%26%20FEES', method: 'GET', body: null })
  })

  it('the section cards: GETs the list the office browses by', async () => {
    const f = mockFetchOk({ sections: [{ section: 'NM CABLE', itemCount: 4 }] })
    const r = await crmSync.fetchQuoteSections()
    expect(lastCall(f)).toEqual({ url: 'https://rce.example.com/api/health-record/quote-catalog/sections', method: 'GET', body: null })
    expect(r.sections).toEqual([{ section: 'NM CABLE', itemCount: 4 }])
  })
})

describe("a line's location and note", () => {
  it('add: both ride with the new line', async () => {
    const f = mockFetchOk({ lineId: 'l1' })
    await crmSync.addQuoteLine('d1', { itemId: 'A016', quantity: 1, option: 'B', location: 'Garage', note: 'left wall' })
    expect(lastCall(f)).toEqual({
      url: 'https://rce.example.com/api/health-record/quotes/d1/lines',
      method: 'POST',
      body: { itemId: 'A016', quantity: 1, option: 'B', location: 'Garage', note: 'left wall' },
    })
  })

  it('edit: a location alone is a partial patch; null clears a box', async () => {
    const f = mockFetchOk({})
    await crmSync.editQuoteLine('l1', { location: 'Kitchen' })
    expect(lastCall(f).body).toEqual({ location: 'Kitchen' })
    await crmSync.editQuoteLine('l1', { location: null, note: null })
    expect(lastCall(f)).toEqual({ url: 'https://rce.example.com/api/health-record/quote-lines/l1', method: 'PATCH', body: { location: null, note: null } })
  })
})
