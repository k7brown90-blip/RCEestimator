/**
 * Options past C and line order on the field Quote screen (2026-10-08, one-estimating-system plan,
 * Phase 1 unit 1c). The tech calls the same service functions as the CRM through the tech-scoped
 * wrappers; these pin the request shapes and that a server refusal reaches the screen as a readable
 * CrmRequestError (the board prints it beside its own buttons). Plain online calls, like
 * editQuoteLine / removeQuoteLine — no offline queue, so a fetch that fails throws.
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

const optionSet = {
  options: [
    { option: 'A', label: null, note: null, lineCount: 1, removable: false },
    { option: 'B', label: null, note: null, lineCount: 0, removable: false },
    { option: 'C', label: null, note: null, lineCount: 0, removable: false },
    { option: 'D', label: null, note: null, lineCount: 0, removable: true },
  ],
  nextOption: 'E',
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

describe('addQuoteOption', () => {
  it("posts to the quote's options route with an empty body (the server picks the letter)", async () => {
    const f = mockFetchOk({ option: 'D', optionSet })
    const r = await crmSync.addQuoteOption('draft-1')
    expect(lastCall(f)).toEqual({
      url: 'https://rce.example.com/api/health-record/quotes/draft-1/options',
      method: 'POST',
      body: {},
    })
    expect(r.option).toBe('D')
    expect(r.optionSet.nextOption).toBe('E')
  })

  it("the limit comes through as the server's own words", async () => {
    mockFetchRefusal({ success: false, error: { code: 'bad_request', message: 'Eight options is the limit.' } })
    await expect(crmSync.addQuoteOption('draft-1')).rejects.toThrow('Eight options is the limit.')
  })
})

describe('removeQuoteOption', () => {
  it('deletes the option by letter and returns how many lines went with it', async () => {
    const f = mockFetchOk({ option: 'D', linesRemoved: 2, optionSet })
    const r = await crmSync.removeQuoteOption('draft-1', 'D')
    expect(lastCall(f)).toEqual({
      url: 'https://rce.example.com/api/health-record/quotes/draft-1/options/D',
      method: 'DELETE',
      body: null,
    })
    expect(r.linesRemoved).toBe(2)
  })

  it('a refusal (A, B and C are permanent) is a readable CrmRequestError', async () => {
    mockFetchRefusal({ success: false, error: { code: 'bad_request', message: 'Option A is permanent.' } })
    let caught: unknown
    try { await crmSync.removeQuoteOption('draft-1', 'A') } catch (err) { caught = err }
    expect(caught).toBeInstanceOf(crmSync.CrmRequestError)
    expect((caught as Error).message).toBe('Option A is permanent.')
  })
})

describe('saveQuoteLineOrder', () => {
  it('puts the FULL ordered list, wrapped as { order }, each line with the option it now sits in', async () => {
    const f = mockFetchOk({ saved: 3, changed: 2 })
    const order = [
      { lineId: 'l2', option: 'A' as const },
      { lineId: 'l1', option: 'A' as const },
      { lineId: 'l3', option: 'D' as const },
    ]
    const r = await crmSync.saveQuoteLineOrder('draft-1', order)
    expect(lastCall(f)).toEqual({
      url: 'https://rce.example.com/api/health-record/quotes/draft-1/line-order',
      method: 'PUT',
      body: { order },
    })
    expect(r).toEqual({ saved: 3, changed: 2 })
  })

  it('a refused order (a line that is not on this quote) is a readable error, never a silent no-op', async () => {
    mockFetchRefusal({ success: false, error: { code: 'bad_request', message: 'That line is not on this estimate.' } })
    await expect(crmSync.saveQuoteLineOrder('draft-1', [{ lineId: 'x', option: 'A' }])).rejects.toThrow('That line is not on this estimate.')
  })

  it('a stranger technician gets a 403, not a silent failure', async () => {
    mockFetchRefusal({ success: false, error: { code: 'forbidden', message: 'Not your quote' } }, 403)
    await expect(crmSync.saveQuoteLineOrder('draft-9', [])).rejects.toThrow('Not your quote')
  })
})
