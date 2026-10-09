/**
 * Title & scope, delete, and copy-to-new on the field Quote screen (2026-10-08, one-estimating-
 * system plan, Phase 2 unit B). The tech calls the same service functions as Estimate Intake
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

function mockFetchOk(data: unknown, status = 200) {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, status, json: () => Promise.resolve({ success: true, data }) })
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

describe('setQuoteDetails', () => {
  it('PUTs the title and scope to the quote; an empty scope is sent as null (the server clears it)', async () => {
    const f = mockFetchOk({ id: 'draft-1', title: 'Panel change', jobDescription: null })
    const r = await crmSync.setQuoteDetails('draft-1', { title: 'Panel change', jobDescription: null })
    expect(lastCall(f)).toEqual({
      url: 'https://rce.example.com/api/health-record/quotes/draft-1/details',
      method: 'PUT',
      body: { title: 'Panel change', jobDescription: null },
    })
    expect(r.title).toBe('Panel change')
  })
  it('either field alone is a valid edit', async () => {
    const f = mockFetchOk({ id: 'draft-1', title: 'Panel change', jobDescription: 'Replace the 100A panel.' })
    await crmSync.setQuoteDetails('draft-1', { jobDescription: 'Replace the 100A panel.' })
    expect(lastCall(f).body).toEqual({ jobDescription: 'Replace the 100A panel.' })
  })
})

describe('deleteQuote', () => {
  it('DELETEs the quote', async () => {
    const f = mockFetchOk({ deleted: true, title: 'Panel change' })
    const r = await crmSync.deleteQuote('draft-1')
    expect(lastCall(f).url).toBe('https://rce.example.com/api/health-record/quotes/draft-1')
    expect(lastCall(f).method).toBe('DELETE')
    expect(r).toEqual({ deleted: true, title: 'Panel change' })
  })
  it('a refusal (issued already) reaches the screen with the server\'s sentence and body', async () => {
    const message = 'Estimate 2026-1098 was issued from this quote, so the quote is its record and stays.'
    mockFetchRefusal({ success: false, error: { code: 'conflict', message } }, 409)
    await expect(crmSync.deleteQuote('draft-1')).rejects.toMatchObject({ name: 'CrmRequestError', message })
  })
})

describe('copyQuoteToNew', () => {
  it('POSTs duplicate and hands back the new draft id', async () => {
    const f = mockFetchOk({ draftId: 'draft-2', title: 'Panel change' }, 201)
    const r = await crmSync.copyQuoteToNew('draft-1')
    expect(lastCall(f)).toEqual({
      url: 'https://rce.example.com/api/health-record/quotes/draft-1/duplicate',
      method: 'POST',
      body: {},
    })
    expect(r.draftId).toBe('draft-2')
  })
})
