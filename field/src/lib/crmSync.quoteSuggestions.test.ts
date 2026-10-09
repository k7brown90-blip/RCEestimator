/**
 * AI proposals, open questions and the walkthrough list on the field Quote screen (2026-10-08,
 * one-estimating-system plan, Phase 2, unit D). The tech calls the same service functions as the CRM
 * through tech-scoped wrappers; these pin the request shapes and that a server refusal reaches the
 * screen as a readable CrmRequestError. Plain online calls — no offline queue (that is Phase 7).
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

describe('confirmSuggestedLine', () => {
  it('Confirm: POSTs an empty body to the line — the suggestion exactly as proposed', async () => {
    const f = mockFetchOk({ lineId: 'l1' })
    await crmSync.confirmSuggestedLine('l1')
    expect(lastCall(f)).toEqual({ url: 'https://rce.example.com/api/health-record/quote-lines/l1/confirm', method: 'POST', body: {} })
  })

  it('Edit & confirm: only what was changed rides along', async () => {
    const f = mockFetchOk({ lineId: 'l1' })
    await crmSync.confirmSuggestedLine('l1', { quantity: 5, difficulty: 'DIFFICULT' })
    expect(lastCall(f).body).toEqual({ quantity: 5, difficulty: 'DIFFICULT' })
  })

  it("a refusal reaches the screen in the server's words", async () => {
    mockFetchRefusal({ success: false, error: { code: 'bad_request', message: 'Negative quantities are only allowed on a change order.' } })
    await expect(crmSync.confirmSuggestedLine('l1', { quantity: -1 })).rejects.toThrow('only allowed on a change order')
  })

  it('a signed quote refuses with its sentence', async () => {
    mockFetchRefusal({ success: false, error: { code: 'bad_request', message: 'Estimate 2026-1098 from this draft is SIGNED.' } })
    await expect(crmSync.confirmSuggestedLine('l1')).rejects.toThrow('is SIGNED')
  })
})

describe('rejectSuggestedLine', () => {
  it('POSTs to the line\'s reject — the suggestion is dropped', async () => {
    const f = mockFetchOk({})
    await crmSync.rejectSuggestedLine('l1')
    expect(lastCall(f)).toEqual({ url: 'https://rce.example.com/api/health-record/quote-lines/l1/reject', method: 'POST', body: {} })
  })

  it("someone else's quote is a 403, not a silent success", async () => {
    mockFetchRefusal({ success: false, error: { code: 'forbidden', message: 'Not your quote' } }, 403)
    await expect(crmSync.rejectSuggestedLine('l9')).rejects.toThrow('Not your quote')
  })
})

describe('resolveQuoteQuestion', () => {
  it('POSTs the answer to the question', async () => {
    const f = mockFetchOk({})
    await crmSync.resolveQuoteQuestion('q1', 'A 20A outdoor GFCI.')
    expect(lastCall(f)).toEqual({
      url: 'https://rce.example.com/api/health-record/quote-questions/q1/resolve',
      method: 'POST',
      body: { resolutionNote: 'A 20A outdoor GFCI.' },
    })
  })
})

describe('proposeFromWalkthroughList ("Build the draft (AI)")', () => {
  it('POSTs the typed list to the quote and returns which brain answered', async () => {
    const f = mockFetchOk({ path: 'basic', degradedReason: 'The AI helper is unavailable right now.', proposed: [], questions: [], rejected: [] })
    const r = await crmSync.proposeFromWalkthroughList('draft-1', '4 20A receptacle\n50 ft EMT')
    expect(lastCall(f)).toEqual({
      url: 'https://rce.example.com/api/health-record/quotes/draft-1/walkthrough/propose',
      method: 'POST',
      body: { text: '4 20A receptacle\n50 ft EMT' },
    })
    expect(r.path).toBe('basic')
    expect(r.degradedReason).toBe('The AI helper is unavailable right now.')
  })

  it('a signed quote is refused before any model call, with the signed sentence', async () => {
    mockFetchRefusal({ success: false, error: { code: 'bad_request', message: 'Estimate 2026-1098 from this draft is SIGNED.' } })
    await expect(crmSync.proposeFromWalkthroughList('draft-1', '4 outlets')).rejects.toThrow('is SIGNED')
  })
})

describe('matchWalkthroughList ("Basic match only")', () => {
  it('POSTs one row per typed line to the catalog resolver', async () => {
    const f = mockFetchOk({ rows: [] })
    await crmSync.matchWalkthroughList(['4 20A receptacle', '50 ft EMT'])
    expect(lastCall(f)).toEqual({
      url: 'https://rce.example.com/api/health-record/quote-catalog/resolve-walkthrough',
      method: 'POST',
      body: { rows: [{ raw: '4 20A receptacle' }, { raw: '50 ft EMT' }] },
    })
  })
})
