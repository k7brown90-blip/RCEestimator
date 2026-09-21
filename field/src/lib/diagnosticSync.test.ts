/**
 * The circuit diagnostic, on the phone (Kyle, 2026-09-20).
 *
 * Two things are being proved here, and they are the two that would cost real
 * money if they were wrong:
 *
 *  1. DURABILITY. A technician walks a circuit in a basement with no signal.
 *     Every outlet, every reading and every photo has to survive that, and the
 *     finished report has to flush whole when the bars come back. This is the
 *     same contract the receipt queue earned on 2026-09-11, when four receipt
 *     photos were photographed and lost because nothing wrote them down first.
 *
 *  2. THE RCE STANDARD. The report states whole-circuit coverage on its face,
 *     and an outlet found beyond the quoted count is counted at its OWN access
 *     tier — "the count is discovered, not negotiated" (Kyle).
 */

import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { coverageStatement, moneySummary } from '../../../shared/diagnostics'

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
  vi.stubGlobal('crypto', { randomUUID: () => `id-${Math.random().toString(36).slice(2, 12)}` })
  vi.stubGlobal('__BUILD_ID__', 'test-build')
}

const okFetch = (data: unknown = {}) => {
  const fn = vi.fn().mockResolvedValue({ ok: true, status: 201, json: () => Promise.resolve({ success: true, data }) })
  vi.stubGlobal('fetch', fn)
  return fn
}
const deadFetch = () => {
  const fn = vi.fn().mockRejectedValue(new Error('Network request failed'))
  vi.stubGlobal('fetch', fn)
  return fn
}

let mod: typeof import('./diagnosticSync')
let db: typeof import('../db/database').db

beforeEach(async () => {
  stubBrowser()
  vi.resetModules()
  mod = await import('./diagnosticSync')
  db = (await import('../db/database')).db
  await db.diagnostics.clear()
  await db.diagnosticSyncQueue.clear()
  await db.diagnosticPhotoQueue.clear()
  await db.photos.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('a diagnostic survives no signal', () => {
  it('starts with no network call at all — a basement is not a blocker', async () => {
    const fetchSpy = deadFetch()
    const record = await mod.startDiagnostic({
      visitId: 'visit-1',
      complaint: 'Half the kitchen is dead',
      circuitLabel: 'Kitchen SABC',
    })
    expect(record.status).toBe('in_progress')
    // It exists on the phone regardless of what the network did.
    expect(await db.diagnostics.get(record.reportId)).toBeTruthy()
    // The push was ATTEMPTED and failed; the row stays queued with a reason.
    const queued = await db.diagnosticSyncQueue.get(record.reportId)
    expect(queued).toBeTruthy()
    expect(queued!.lastError).toMatch(/Network request failed/)
    expect(fetchSpy).toHaveBeenCalled()
  })

  it('keeps ONE queue row per report however many outlets are added offline', async () => {
    deadFetch()
    const record = await mod.startDiagnostic({ visitId: 'v', complaint: 'c', circuitLabel: 'Circuit 2' })
    let working = (await db.diagnostics.get(record.reportId))!
    for (let i = 1; i <= 6; i += 1) {
      working = { ...working, outlets: [...working.outlets, { ...mod.emptyOutlet(i), locationLabel: `Box ${i}` }] }
      await mod.saveDiagnostic(working)
    }
    // A circuit walked over an hour with no signal is still one push, not six.
    expect(await db.diagnosticSyncQueue.count()).toBe(1)
    const payload = JSON.parse((await db.diagnosticSyncQueue.get(record.reportId))!.payload)
    expect(payload.outlets).toHaveLength(6)
    expect(payload.outlets[5].locationLabel).toBe('Box 6')
  })

  it('writes the photo bytes and its queue row BEFORE any upload is attempted', async () => {
    deadFetch()
    const record = await mod.startDiagnostic({ visitId: 'v', complaint: 'c', circuitLabel: 'Circuit 2' })
    const outlet = mod.emptyOutlet(1)
    await mod.saveDiagnostic({ ...(await db.diagnostics.get(record.reportId))!, outlets: [outlet] })

    const blob = new Blob(['jpeg-bytes'], { type: 'image/jpeg' })
    const { photoId } = await mod.captureOutletPhoto(record.reportId, outlet.id, blob)

    // The bytes are on the device and the queue row exists BEFORE any upload —
    // the exact thing that did NOT happen on 2026-09-11.
    expect(await db.photos.get(photoId)).toBeTruthy()
    expect(await db.diagnosticPhotoQueue.get(photoId)).toBeTruthy()

    // And a failed attempt leaves the row with a reason rather than dropping it.
    await mod.flushDiagnosticQueue()
    const queued = await db.diagnosticPhotoQueue.get(photoId)
    expect(queued).toBeTruthy()
    expect(queued!.lastError).toMatch(/Photo upload failed|Network request failed/)
    // And the outlet already counts it as taken.
    const after = await db.diagnostics.get(record.reportId)
    expect(after!.outlets[0].photoIds).toEqual([photoId])
  })

  it('flushes the whole report and its photos when the signal comes back', async () => {
    deadFetch()
    const record = await mod.startDiagnostic({ visitId: 'v', complaint: 'c', circuitLabel: 'Circuit 2' })
    const outlet = { ...mod.emptyOutlet(1), locationLabel: 'Kitchen' }
    await mod.saveDiagnostic({ ...(await db.diagnostics.get(record.reportId))!, outlets: [outlet] })
    await mod.captureOutletPhoto(record.reportId, outlet.id, new Blob(['x'], { type: 'image/jpeg' }))
    expect((await mod.pendingDiagnosticCount()).reports).toBe(1)
    expect((await mod.pendingDiagnosticCount()).photos).toBe(1)

    okFetch({ id: record.reportId })
    await mod.flushDiagnosticQueue()

    expect(await mod.pendingDiagnosticCount()).toEqual({ reports: 0, photos: 0 })
    expect((await db.diagnostics.get(record.reportId))!.syncedAt).toBeTruthy()
  })

  it('never silently drops a photo whose bytes were evicted — it stays visible with a reason', async () => {
    okFetch({})
    const record = await mod.startDiagnostic({ visitId: 'v', complaint: 'c', circuitLabel: 'C' })
    const outlet = mod.emptyOutlet(1)
    await mod.saveDiagnostic({ ...(await db.diagnostics.get(record.reportId))!, outlets: [outlet] })
    const { photoId } = await mod.captureOutletPhoto(record.reportId, outlet.id, new Blob(['x'], { type: 'image/jpeg' }))
    await mod.flushDiagnosticQueue()

    // Simulate browser storage pressure evicting the blob, then re-queue it.
    await db.photos.delete(photoId)
    await db.diagnosticPhotoQueue.put({ photoId, reportId: record.reportId, attempts: 0, queuedAt: new Date().toISOString() })
    await mod.flushDiagnosticQueue()

    const still = await db.diagnosticPhotoQueue.get(photoId)
    expect(still).toBeTruthy()
    expect(still!.lastError).toMatch(/evicted/)
  })
})

describe('what has to be true before it reaches a homeowner', () => {
  const base = () => ({
    reportId: 'r', visitId: 'v', reportDate: new Date().toISOString(),
    complaint: 'c', circuitLabel: 'Circuit 2', circuitNumber: null, panelLocation: null,
    breakerRating: null, breakerInspected: true, coverage: 'whole_circuit' as const,
    coverageNote: null, summary: null, diagnosticItemId: null,
    quotedNormal: 0, quotedDifficult: 0, quotedVeryDifficult: 0,
    status: 'in_progress' as const, outlets: [], syncedAt: null, updatedAt: new Date().toISOString(),
  })

  it('refuses an outlet with no photo — a claim is not a record', () => {
    const outlet = { ...mod.emptyOutlet(1), locationLabel: 'Kitchen', photoIds: [] }
    expect(mod.readyToComplete({ ...base(), outlets: [outlet] })).toContain(
      'Kitchen has no photo — an outlet with no photo is a claim.',
    )
  })

  it('refuses a partial walk that does not say where it stopped', () => {
    const outlet = { ...mod.emptyOutlet(1), locationLabel: 'Kitchen', photoIds: ['p1'] }
    const blockers = mod.readyToComplete({ ...base(), coverage: 'partial', outlets: [outlet] })
    expect(blockers).toContain('A partial walk has to say where it stopped and why.')
  })

  it('refuses defective equipment with no description — that is what the change order quotes', () => {
    const outlet = {
      ...mod.emptyOutlet(1), locationLabel: 'Kitchen', photoIds: ['p1'],
      equipmentDefective: true, defectDescription: null,
    }
    expect(mod.readyToComplete({ ...base(), outlets: [outlet] }).join(' ')).toMatch(/what is wrong with the equipment/)
  })

  it('clears once every box has a location, a photo, and its defect described', () => {
    const outlet = {
      ...mod.emptyOutlet(1), locationLabel: 'Kitchen', photoIds: ['p1'],
      equipmentDefective: true, defectDescription: 'Receptacle body cracked',
    }
    expect(mod.readyToComplete({ ...base(), outlets: [outlet] })).toEqual([])
  })
})

describe('THE RCE STANDARD — coverage and the discovered count', () => {
  it('states whole-circuit coverage on the face of the report', () => {
    const statement = coverageStatement({
      coverage: 'whole_circuit', coverageNote: null, circuitLabel: 'Kitchen SABC',
      breakerInspected: true, examinedTotal: 9,
    })
    expect(statement).toMatch(/WHOLE-CIRCUIT COVERAGE/)
    expect(statement).toMatch(/breaker to last outlet: 9 outlets examined/)
    expect(statement).toMatch(/we do not stop at the fault/)
  })

  it('never implies coverage it does not carry', () => {
    const statement = coverageStatement({
      coverage: 'partial', coverageNote: 'Customer stopped us at the hallway', circuitLabel: 'Circuit 2',
      breakerInspected: false, examinedTotal: 3,
    })
    expect(statement).toMatch(/PARTIAL COVERAGE/)
    expect(statement).toMatch(/Customer stopped us at the hallway/)
    expect(statement).toMatch(/not covered by this report/)
    expect(statement).not.toMatch(/WHOLE-CIRCUIT/)
  })

  it('counts an outlet beyond the quote at its OWN tier, not at the cheapest one', () => {
    // Kyle's example: 3 normal, 2 ceiling (difficult), 1 hard to reach quoted.
    const quoted = { NORMAL: 3, DIFFICULT: 2, VERY_DIFFICULT: 1 }
    // The circuit actually held two more normals and one more very difficult.
    const examined = { NORMAL: 5, DIFFICULT: 2, VERY_DIFFICULT: 2 }
    const money = moneySummary(quoted, examined)
    expect(money.overage).toEqual({ NORMAL: 2, DIFFICULT: 0, VERY_DIFFICULT: 1 })
    expect(money.overageTotal).toBe(3)
    expect(money.examinedTotal).toBe(9)
  })

  it('a tier examined FEWER times than quoted is zero overage, never a credit', () => {
    const money = moneySummary({ NORMAL: 5, DIFFICULT: 0, VERY_DIFFICULT: 0 }, { NORMAL: 2, DIFFICULT: 0, VERY_DIFFICULT: 0 })
    expect(money.overage.NORMAL).toBe(0)
    expect(money.overageTotal).toBe(0)
  })

  it('computes the same money summary the server does, from the local record', async () => {
    deadFetch()
    const record = await mod.startDiagnostic({
      visitId: 'v', complaint: 'c', circuitLabel: 'C',
      quoted: { NORMAL: 1, DIFFICULT: 0, VERY_DIFFICULT: 0 },
    })
    const working = {
      ...(await db.diagnostics.get(record.reportId))!,
      outlets: [
        { ...mod.emptyOutlet(1), difficulty: 'NORMAL' as const },
        { ...mod.emptyOutlet(2), difficulty: 'NORMAL' as const },
        { ...mod.emptyOutlet(3), difficulty: 'VERY_DIFFICULT' as const },
      ],
    }
    const money = mod.localMoneySummary(working)
    expect(money.examined).toEqual({ NORMAL: 2, DIFFICULT: 0, VERY_DIFFICULT: 1 })
    expect(money.overage).toEqual({ NORMAL: 1, DIFFICULT: 0, VERY_DIFFICULT: 1 })
  })
})
