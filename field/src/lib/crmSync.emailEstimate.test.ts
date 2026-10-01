/**
 * Field emails the issued estimate (2026-10-01) — replaces the old "share via
 * text" button on QuoteScreen's post-issue screen. Red Cedar has no SMS
 * (Kyle, 2026-08-16), so `navigator.share(...)` ("Share the link to their
 * phone") is gone and the tech instead posts the estimate's id to the server,
 * which resolves the customer's address and sends through the SAME
 * `sendEstimateEmail` the CRM uses.
 *
 * Pins:
 *  - the request shape (method, URL keyed by estimate id, empty body) —
 *    nothing here ever carries the estimate's signing token;
 *  - a successful send surfaces the address it went to, so the tech can tell
 *    the customer "it's gone to you at X";
 *  - a server refusal (409, e.g. no customer email on file) comes through as
 *    a CrmRequestError the screen can show, not a silent failure.
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

describe('emailEstimateToCustomer', () => {
  it('posts the estimate id to its own tech-scoped route, with no body carrying a token', async () => {
    const f = mockFetchOk({ to: 'homeowner@example.com' })
    const r = await crmSync.emailEstimateToCustomer('est-1')
    expect(lastCall(f)).toEqual({
      url: 'https://rce.example.com/api/health-record/issued-estimates/est-1/email',
      method: 'POST',
      body: {},
    })
    expect(r).toEqual({ to: 'homeowner@example.com' })
  })

  it('surfaces the address the email went to, for the tech to say out loud', async () => {
    mockFetchOk({ to: 'jane.doe@example.com' })
    const r = await crmSync.emailEstimateToCustomer('est-2')
    expect(r.to).toBe('jane.doe@example.com')
  })

  it('a server refusal (e.g. no customer email on file) comes through as a readable CrmRequestError', async () => {
    mockFetchRefusal({ success: false, error: { code: 'not_sent', message: 'No valid customer email address on this estimate.' } })

    let caught: unknown
    try {
      await crmSync.emailEstimateToCustomer('est-3')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(crmSync.CrmRequestError)
    expect((caught as Error).message).toBe('No valid customer email address on this estimate.')
  })

  it('a technician not assigned to the visit gets a 403, not a silent failure', async () => {
    mockFetchRefusal({ success: false, error: { code: 'forbidden', message: 'This estimate is not on one of your visits' } }, 403)

    await expect(crmSync.emailEstimateToCustomer('est-4')).rejects.toThrow('This estimate is not on one of your visits')
  })
})
