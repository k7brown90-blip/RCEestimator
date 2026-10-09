/**
 * Discount, option names, one-or-the-other mode and copy-an-option on the field Quote screen
 * (2026-10-08, one-estimating-system plan, Phase 2, unit A). The tech calls the same service
 * functions as the CRM through tech-scoped wrappers; these pin the request shapes and that a server
 * refusal reaches the screen as a readable CrmRequestError. Plain online calls, like addQuoteOption —
 * no offline queue (that is Phase 7), so a failed fetch throws.
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

function mockFetchRefusal(body: unknown, status = 400) {
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

describe('setQuoteDiscount', () => {
  it('Military: PUTs the programme to the quote — percent null, the server owns the rate and the cap', async () => {
    const f = mockFetchOk({ discountType: 'military', discountPercent: null })
    const r = await crmSync.setQuoteDiscount('draft-1', { type: 'military' })
    expect(lastCall(f)).toEqual({
      url: 'https://rce.example.com/api/health-record/quotes/draft-1/discount',
      method: 'PUT',
      body: { type: 'military', percent: null },
    })
    expect(r.discountType).toBe('military')
  })

  it('a custom percentage rides along; Clear is type null', async () => {
    const f = mockFetchOk({ discountType: 'custom', discountPercent: 7.5 })
    await crmSync.setQuoteDiscount('draft-1', { type: 'custom', percent: 7.5 })
    expect(lastCall(f).body).toEqual({ type: 'custom', percent: 7.5 })
    await crmSync.setQuoteDiscount('draft-1', { type: null })
    expect(lastCall(f).body).toEqual({ type: null, percent: null })
  })

  it("a refused percentage reaches the screen in the server's own words", async () => {
    mockFetchRefusal({ success: false, error: { code: 'bad_request', message: 'A custom discount needs a percentage above 0 and at most 50.' } })
    await expect(crmSync.setQuoteDiscount('draft-1', { type: 'custom', percent: 80 })).rejects.toThrow(
      'A custom discount needs a percentage above 0 and at most 50.',
    )
  })

  it("someone else's quote is a 403, not a silent success", async () => {
    mockFetchRefusal({ success: false, error: { code: 'forbidden', message: 'Not your quote' } }, 403)
    await expect(crmSync.setQuoteDiscount('draft-9', { type: 'senior' })).rejects.toThrow('Not your quote')
  })
})

describe('setQuoteOptionsMode', () => {
  it('PUTs { exclusive } to the quote', async () => {
    const f = mockFetchOk({ exclusiveOptions: true })
    const r = await crmSync.setQuoteOptionsMode('draft-1', true)
    expect(lastCall(f)).toEqual({
      url: 'https://rce.example.com/api/health-record/quotes/draft-1/options-mode',
      method: 'PUT',
      body: { exclusive: true },
    })
    expect(r.exclusiveOptions).toBe(true)
  })
})

describe('saveQuoteOptionMeta', () => {
  it('PUTs the name and description to the option; an empty string is how a name is taken off', async () => {
    const f = mockFetchOk({ option: 'D', label: 'Whole-house rewire', note: null })
    await crmSync.saveQuoteOptionMeta('draft-1', 'D', { label: 'Whole-house rewire', note: '' })
    expect(lastCall(f)).toEqual({
      url: 'https://rce.example.com/api/health-record/quotes/draft-1/options/D',
      method: 'PUT',
      body: { label: 'Whole-house rewire', note: '' },
    })
  })
})

describe('copyQuoteOption', () => {
  it('POSTs { from, to } and returns how many lines were copied', async () => {
    const f = mockFetchOk({ copied: 3, from: 'A', to: 'B' })
    const r = await crmSync.copyQuoteOption('draft-1', 'A', 'B')
    expect(lastCall(f)).toEqual({
      url: 'https://rce.example.com/api/health-record/quotes/draft-1/options/copy',
      method: 'POST',
      body: { from: 'A', to: 'B' },
    })
    expect(r.copied).toBe(3)
  })

  it('a signed quote refuses with its reason, readable on the screen', async () => {
    mockFetchRefusal({ success: false, error: { code: 'bad_request', message: 'Estimate 2026-1098 from this draft is SIGNED.' } })
    await expect(crmSync.copyQuoteOption('draft-1', 'A', 'B')).rejects.toThrow('is SIGNED')
  })
})
