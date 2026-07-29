/**
 * Offline assignment cache.
 *
 * A technician standing at a panel in a crawlspace with no signal still has to
 * be able to open the job they're already at. The rule this file protects: a
 * failed network read falls back to the cached list and says so, rather than
 * showing an empty queue that looks exactly like "no work assigned".
 */

import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CrmAssignment } from '../domain/types'

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
  return store
}

const assignment = (overrides: Partial<CrmAssignment> = {}): CrmAssignment => ({
  assignmentId: 'a1',
  assignmentStatus: 'assigned',
  role: 'primary',
  visitId: 'v1',
  visitStatus: 'scheduled',
  jobType: 'Health inspection',
  purpose: 'Electrical health inspection',
  scheduledStart: '2026-08-04T14:00:00.000Z',
  scheduledEnd: null,
  estimatedDurationDays: 1,
  customerId: 'c1',
  customerName: 'Hollis',
  customerPhone: '+16155550123',
  propertyId: 'prop1',
  propertyName: 'Home',
  address: {
    line1: '605 Green Farm Way', line2: null, city: 'Murfreesboro',
    state: 'TN', postalCode: '37130',
    formatted: '605 Green Farm Way, Murfreesboro, TN 37130',
  },
  jurisdictionId: 'murfreesboro',
  jurisdictionSource: 'city',
  lastInspectionDate: null,
  ...overrides,
})

function mockFetchOk(data: unknown) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ success: true, data }),
  }))
}

function mockFetchFailure() {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network request failed')))
}

let syncAssignments: typeof import('./crmSync').syncAssignments
let fetchMe: typeof import('./crmSync').fetchMe
let cachedMe: typeof import('./crmSync').cachedMe
let db: typeof import('../db/database').db

beforeEach(async () => {
  stubBrowser()
  vi.resetModules()
  const crmSync = await import('./crmSync')
  syncAssignments = crmSync.syncAssignments
  fetchMe = crmSync.fetchMe
  cachedMe = crmSync.cachedMe
  db = (await import('../db/database')).db
  await db.open()
  await db.assignments.clear()
  await db.meta.clear()
})

afterEach(async () => {
  db.close()
  await (await import('dexie')).default.delete('red-cedar-health-record')
  vi.unstubAllGlobals()
})

describe('syncAssignments', () => {
  it('returns the live list and caches it', async () => {
    mockFetchOk([assignment()])

    const result = await syncAssignments()
    expect(result.stale).toBe(false)
    expect(result.assignments).toHaveLength(1)
    expect(result.assignments[0].customerName).toBe('Hollis')
    expect(await db.assignments.count()).toBe(1)
  })

  it('falls back to the cache when the network is down, flagged as stale', async () => {
    mockFetchOk([assignment()])
    await syncAssignments()

    mockFetchFailure()
    const offline = await syncAssignments()

    expect(offline.stale).toBe(true)
    expect(offline.assignments).toHaveLength(1)
    expect(offline.assignments[0].address.line1).toBe('605 Green Farm Way')
    expect(offline.cachedAt).toBeTruthy()
    expect(offline.error).toContain('Network request failed')
  })

  it('never throws on a network failure — an empty queue must not look like no work', async () => {
    mockFetchFailure()
    const result = await syncAssignments()
    expect(result.stale).toBe(true)
    expect(result.assignments).toEqual([])
  })

  it('prunes reassigned work instead of leaving it in the cache forever', async () => {
    mockFetchOk([assignment({ visitId: 'v1' }), assignment({ visitId: 'v2', assignmentId: 'a2' })])
    await syncAssignments()
    expect(await db.assignments.count()).toBe(2)

    // v2 was handed to another technician.
    mockFetchOk([assignment({ visitId: 'v1' })])
    const result = await syncAssignments()

    expect(result.assignments.map((a) => a.visitId)).toEqual(['v1'])
    expect(await db.assignments.count()).toBe(1)
  })

  it('carries the resolved jurisdiction through the cache', async () => {
    // The whole point of resolving server-side is lost if the offline copy
    // drops it and the app falls back to guessing.
    mockFetchOk([assignment({ jurisdictionId: 'nashville', jurisdictionSource: 'territory' })])
    await syncAssignments()

    mockFetchFailure()
    const offline = await syncAssignments()
    expect(offline.assignments[0].jurisdictionId).toBe('nashville')
    expect(offline.assignments[0].jurisdictionSource).toBe('territory')
  })

  it('caches an unconfirmed jurisdiction as unconfirmed', async () => {
    mockFetchOk([assignment({ jurisdictionSource: 'default' })])
    await syncAssignments()

    mockFetchFailure()
    const offline = await syncAssignments()
    expect(offline.assignments[0].jurisdictionSource).toBe('default')
  })
})

describe('technician identity cache', () => {
  it('caches the enrolled technician so their name survives going offline', async () => {
    mockFetchOk({ id: 't1', name: 'Michael Schramm', role: 'technician' })
    const me = await fetchMe()
    expect(me.name).toBe('Michael Schramm')

    vi.unstubAllGlobals()
    stubBrowser()
    expect((await cachedMe())?.name).toBe('Michael Schramm')
  })

  it('returns null before enrollment rather than inventing a name', async () => {
    expect(await cachedMe()).toBeNull()
  })

  it('propagates an auth failure instead of caching a bad identity', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ success: false, error: { message: 'Invalid technician token' } }),
    }))

    await expect(fetchMe()).rejects.toThrow('Invalid technician token')
    expect(await cachedMe()).toBeNull()
  })
})
