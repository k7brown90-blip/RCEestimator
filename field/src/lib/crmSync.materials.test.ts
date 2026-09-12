/**
 * Barcode/SKU materials lookup (barcode/materials plan Unit 3, 2026-09-12).
 *
 * Kyle: "We can't have this turn into a complicated process or a manual entry that takes 5
 * minutes per item... I am in the middle of projects while adding these items in for the job
 * that needs done same day." These tests hold the unit to that: a known code resolves with
 * zero typing from the offline cache; a typed SKU resolves exactly the way a scan does,
 * against the same cache; an unknown code still yields a usable PO line and never throws,
 * online or off.
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
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ success: true, data }),
  }))
}

function mockFetchFailure() {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network request failed')))
}

const knownMaterial = {
  id: 'm1',
  upc: '078477123456',
  sku: '5320-W',
  supplier: 'Nashville Electric Supply',
  description: 'Leviton 5320-W duplex receptacle, 10-pack',
  packQty: 10,
  packUnit: 'ea',
  lastCost: 11.97,
  itemId: 'ITM-100',
}

let syncMaterials: typeof import('./crmSync').syncMaterials
let resolveMaterialCode: typeof import('./crmSync').resolveMaterialCode
let lineFromScannedCode: typeof import('./crmSync').lineFromScannedCode
let db: typeof import('../db/database').db

beforeEach(async () => {
  stubBrowser()
  vi.resetModules()
  const crmSync = await import('./crmSync')
  syncMaterials = crmSync.syncMaterials
  resolveMaterialCode = crmSync.resolveMaterialCode
  lineFromScannedCode = crmSync.lineFromScannedCode
  db = (await import('../db/database')).db
  await db.open()
  await db.materials.clear()
})

afterEach(async () => {
  db.close()
  await (await import('dexie')).default.delete('red-cedar-health-record')
  vi.unstubAllGlobals()
})

describe('syncMaterials', () => {
  it('caches the live table and reports it fresh', async () => {
    mockFetchOk({ materials: [knownMaterial] })
    const result = await syncMaterials()
    expect(result.stale).toBe(false)
    expect(result.materials).toHaveLength(1)
    expect(await db.materials.count()).toBe(1)
  })

  it('degrades to the cache when signal is down, same contract as assignments', async () => {
    mockFetchOk({ materials: [knownMaterial] })
    await syncMaterials()

    mockFetchFailure()
    const offline = await syncMaterials()
    expect(offline.stale).toBe(true)
    expect(offline.materials).toHaveLength(1)
    expect(offline.materials[0].upc).toBe('078477123456')
    expect(offline.error).toContain('Network request failed')
  })

  it('never throws on a network failure with an empty cache', async () => {
    mockFetchFailure()
    const result = await syncMaterials()
    expect(result.stale).toBe(true)
    expect(result.materials).toEqual([])
  })

  it('prunes a material removed at the office instead of leaving it cached forever', async () => {
    mockFetchOk({ materials: [knownMaterial, { ...knownMaterial, id: 'm2', upc: '000', sku: 'X' }] })
    await syncMaterials()
    expect(await db.materials.count()).toBe(2)

    mockFetchOk({ materials: [knownMaterial] })
    await syncMaterials()
    expect(await db.materials.count()).toBe(1)
  })
})

describe('resolveMaterialCode — offline cache path', () => {
  beforeEach(async () => {
    await db.materials.put({ ...knownMaterial, cachedAt: '2026-09-12T00:00:00.000Z' })
  })

  it('resolves a scanned UPC from the cache with no network call at all', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('must not be called')))
    const result = await resolveMaterialCode('078477123456', { source: 'upc' })
    expect(result.found).toBe(true)
    expect(result.source).toBe('cache')
    expect(result.material?.description).toContain('Leviton')
  })

  it('resolves a typed SKU from the cache exactly the way a scan does — same function, same cache', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('must not be called')))
    const byScan = await resolveMaterialCode('078477123456', { source: 'upc' })
    const byTyping = await resolveMaterialCode('5320-W', { source: 'sku' })
    expect(byTyping.found).toBe(true)
    expect(byTyping.source).toBe('cache')
    expect(byTyping.material?.id).toBe(byScan.material?.id)
    expect(byTyping.material).toEqual(byScan.material)
  })

  it('works with no signal at all — cache lookups never depend on the network', async () => {
    vi.stubGlobal('navigator', { onLine: false })
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    const result = await resolveMaterialCode('5320-W', { source: 'sku' })
    expect(result.found).toBe(true)
    expect(result.material?.itemId).toBe('ITM-100')
  })
})

describe('resolveMaterialCode — cache miss, online', () => {
  it('asks the server, which resolves a known code not yet cached on this device', async () => {
    mockFetchOk({ found: true, material: knownMaterial })
    const result = await resolveMaterialCode('078477123456', { source: 'upc' })
    expect(result.found).toBe(true)
    expect(result.source).toBe('remote')
    // Caches it locally so the next scan of the same code is instant and offline-safe.
    expect(await db.materials.get('m1')).toBeTruthy()
  })

  it('creates an unassigned material for a brand-new code and still returns it usably', async () => {
    const newMaterial = { id: 'm2', upc: '999888777', sku: null, supplier: null, description: null, packQty: null, packUnit: null, lastCost: null, itemId: null }
    mockFetchOk({ found: false, material: newMaterial })
    const result = await resolveMaterialCode('999888777', { source: 'upc' })
    expect(result.found).toBe(false)
    expect(result.source).toBe('remote')
    expect(result.material?.id).toBe('m2')
    expect(await db.materials.get('m2')).toBeTruthy()
  })
})

describe('resolveMaterialCode — cache miss, offline (the never-block guarantee)', () => {
  it('never throws — an unresolved code is a valid, non-blocking outcome', async () => {
    mockFetchFailure()
    const result = await resolveMaterialCode('unknown-code-123')
    expect(result.found).toBe(false)
    expect(result.source).toBe('unresolved')
    expect(result.material).toBeNull()
  })

  it('treats an empty/whitespace code the same way — unresolved, never thrown', async () => {
    const result = await resolveMaterialCode('   ')
    expect(result.found).toBe(false)
    expect(result.source).toBe('unresolved')
  })
})

describe('lineFromScannedCode', () => {
  it('pre-fills a known material with zero typing: name, pack unit, part number, item link, and pack price', () => {
    const line = lineFromScannedCode('078477123456', { found: true, source: 'cache', material: knownMaterial })
    expect(line).toEqual({
      name: 'Leviton 5320-W duplex receptacle, 10-pack',
      qty: 1,
      unit: 'ea',
      partNumber: '5320-W',
      itemId: 'ITM-100',
      unitCost: 11.97,
    })
  })

  it('still produces a usable line for an unresolved code — the scan is never discarded', () => {
    const line = lineFromScannedCode('999888777', { found: false, source: 'unresolved', material: null })
    expect(line.name).toContain('999888777')
    expect(line.qty).toBe(1)
    expect(line.partNumber).toBe('999888777')
    expect(line.itemId).toBeUndefined()
  })

  it('falls back to the raw code as the part number when the material has neither sku nor upc', () => {
    const bare = { id: 'm3', upc: null, sku: null, supplier: null, description: 'Mystery part', packQty: null, packUnit: null, lastCost: null, itemId: null }
    const line = lineFromScannedCode('typed-code', { found: true, source: 'cache', material: bare })
    expect(line.name).toBe('Mystery part')
    expect(line.partNumber).toBe('typed-code')
    expect(line.unit).toBeUndefined()
    expect(line.unitCost).toBeUndefined()
  })
})
