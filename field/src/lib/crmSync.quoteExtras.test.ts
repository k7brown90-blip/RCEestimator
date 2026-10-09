/**
 * Photos on the estimate, the issue step's extra boxes and "Raise a change order" - the field's
 * request shapes (2026-10-08, one-estimating-system plan, Phase 2 unit E). Plain online calls, no
 * offline queue (that is Phase 7). A server refusal reaches the screen as a readable error.
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

describe('emailEstimateToCustomer - the ticked photos', () => {
  it('no photos ticked: the body it always was', async () => {
    const f = mockFetchOk({ to: 'a@b.c' })
    await crmSync.emailEstimateToCustomer('est-1')
    expect(lastCall(f)).toEqual({ url: 'https://rce.example.com/api/health-record/issued-estimates/est-1/email', method: 'POST', body: {} })
    await crmSync.emailEstimateToCustomer('est-1', { photoIds: [] })
    expect(lastCall(f).body).toEqual({})
  })
  it('photos ticked: their ids ride the same email call', async () => {
    const f = mockFetchOk({ to: 'a@b.c' })
    await crmSync.emailEstimateToCustomer('est-1', { photoIds: ['p1', 'p2'] })
    expect(lastCall(f).body).toEqual({ photoIds: ['p1', 'p2'] })
  })
})

describe('issueQuote - the office\'s other two issue boxes', () => {
  it('sends only what the tech chose; absent keys are the service\'s defaults', async () => {
    const f = mockFetchOk({ estimateId: 'e', number: 'n', unpriced: [], customerUrl: 'u' })
    await crmSync.issueQuote('d1')
    expect(lastCall(f).body).toEqual({})
    await crmSync.issueQuote('d1', { includeGenerator: true })
    expect(lastCall(f).body).toEqual({ includeGenerator: true })
    await crmSync.issueQuote('d1', { depositRequired: false, addToCurrentJob: false })
    expect(lastCall(f).body).toEqual({ depositRequired: false, addToCurrentJob: false })
  })
})

describe('the photo list, the exit, and Raise a change order', () => {
  it('lists the quote\'s photos', async () => {
    const f = mockFetchOk({ photos: [], max: 10, visitId: 'v1' })
    const r = await crmSync.fetchQuotePhotos('d1')
    expect(lastCall(f)).toEqual({ url: 'https://rce.example.com/api/health-record/quotes/d1/photos', method: 'GET', body: null })
    expect(r.visitId).toBe('v1')
  })
  it('previews with the bearer token in a header (an <img> tag cannot send one)', async () => {
    const blob = new Blob(['x'])
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, blob: () => Promise.resolve(blob) })
    vi.stubGlobal('fetch', fetchMock)
    expect(await crmSync.fetchQuotePhotoPreview('d1', 'p1')).toBe(blob)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://rce.example.com/api/health-record/quotes/d1/photos/p1/preview')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok')
  })
  it('takes a photo back with DELETE; a refusal comes through readable', async () => {
    const f = mockFetchOk({ deleted: true })
    await crmSync.deleteQuotePhoto('d1', 'p1')
    expect(lastCall(f)).toEqual({ url: 'https://rce.example.com/api/health-record/quotes/d1/photos/p1', method: 'DELETE', body: null })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 403, json: () => Promise.resolve({ success: false, error: { message: 'Only the technician who took a photo can remove it' } }),
    }))
    await expect(crmSync.deleteQuotePhoto('d1', 'p2')).rejects.toThrow(/Only the technician who took a photo/)
  })
  it('raises a change order from the visit - the phone never holds an estimate id', async () => {
    const f = mockFetchOk({ draftId: 'co1', changeOrderFor: '2026-1098', resumed: false })
    const r = await crmSync.raiseChangeOrder('visit-1')
    expect(lastCall(f)).toEqual({ url: 'https://rce.example.com/api/health-record/visits/visit-1/change-order', method: 'POST', body: {} })
    expect(r.draftId).toBe('co1')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 409, json: () => Promise.resolve({ success: false, error: { message: 'That estimate has not been signed.' } }),
    }))
    await expect(crmSync.raiseChangeOrder('visit-1')).rejects.toThrow(/not been signed/)
  })
})
