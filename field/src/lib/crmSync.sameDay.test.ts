/**
 * Complete work now · Schedule for later · Pause job (Kyle, 2026-09-21) — the
 * field side of the wire.
 *
 * Pins what the phone SENDS for the three verbs and for the deposit checkbox,
 * and that the field's own booking (scheduleVisitFromField -> POST
 * /visits/:id/schedule) no longer exists: scheduling is admin-only. The
 * server's twin, tests/sameDayJob.test.ts, pins what those routes do.
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

describe('after the signature — the three verbs', () => {
  it('Complete work now posts to the visit and books nothing', async () => {
    const f = mockFetchOk({ jobVisitId: 'v1', removedVisitId: 'j1', alreadyDone: false })
    const r = await crmSync.completeWorkNow('v1')
    expect(r).toEqual({ jobVisitId: 'v1', removedVisitId: 'j1', alreadyDone: false })
    expect(lastCall(f)).toEqual({ url: 'https://rce.example.com/api/health-record/visits/v1/complete-work-now', method: 'POST', body: {} })
  })

  it('Schedule for later posts to the visit with no date — the office schedules', async () => {
    const f = mockFetchOk({ jobVisitId: 'j1', depositRequestReleased: true })
    const r = await crmSync.scheduleForLater('v1')
    expect(r.jobVisitId).toBe('j1')
    const call = lastCall(f)
    expect(call.url).toBe('https://rce.example.com/api/health-record/visits/v1/schedule-for-later')
    expect(call.method).toBe('POST')
    expect(call.body).toEqual({})
  })

  it('Pause job is its own route with an optional reason — not the clock pause', async () => {
    const f = mockFetchOk({ paused: true, sessionsClosed: 1, laborHours: 2.5 })
    await crmSync.pauseJobForLater('v1', 'ran out of daylight')
    expect(lastCall(f)).toEqual({ url: 'https://rce.example.com/api/health-record/visits/v1/pause-job', method: 'POST', body: { reason: 'ran out of daylight' } })

    await crmSync.pauseJobForLater('v1')
    expect(lastCall(f).body).toEqual({ reason: null })

    // The CLOCK's pause is a different verb on a different route, unchanged.
    mockFetchOk({ minutes: 30, laborMinutes: 90, laborHours: 1.5 })
    await crmSync.pauseJobClock('v1')
    expect(lastCall(vi.mocked(fetch) as unknown as ReturnType<typeof vi.fn>).url).toBe('https://rce.example.com/api/health-record/visits/v1/pause')
  })

  it('the field can no longer book: scheduleVisitFromField is gone', () => {
    expect((crmSync as unknown as Record<string, unknown>).scheduleVisitFromField).toBeUndefined()
  })
})

describe('the deposit checkbox reaches the issue path', () => {
  it('sends depositRequired only when the tech chose it', async () => {
    const f = mockFetchOk({ estimateId: 'e1', number: 'EST-1', unpriced: [], customerUrl: 'https://rce.example.com/e/tok' })
    await crmSync.issueQuote('d1', { depositRequired: false })
    expect(lastCall(f)).toEqual({ url: 'https://rce.example.com/api/health-record/quotes/d1/issue', method: 'POST', body: { depositRequired: false } })

    await crmSync.issueQuote('d1', { depositRequired: true })
    expect(lastCall(f).body).toEqual({ depositRequired: true })

    // Untouched = the service's default (on for an estimate, off for a change order).
    await crmSync.issueQuote('d1')
    expect(lastCall(f).body).toEqual({})
  })
})
