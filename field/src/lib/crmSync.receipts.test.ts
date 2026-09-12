/**
 * Durable receipt queue (2026-09-12).
 *
 * Incident this protects against: on 2026-09-11 six purchases were
 * photographed and only two receipts reached the server. uploadReceiptFromField
 * was a bare fetch that threw, and every call site caught the error, showed
 * text, and discarded the File — leaving no row, no log, no queue entry, no
 * trace anywhere. These tests prove a failed upload now leaves a durable,
 * retryable trace instead.
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
  return store
}

function mockFetchOk(data: unknown) {
  const fn = vi.fn().mockResolvedValue({
    ok: true,
    status: 201,
    json: () => Promise.resolve({ success: true, data }),
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

function mockFetchFailure() {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network request failed')))
}

const receiptResponse = (overrides: Partial<{ id: string; amount: number; status: string }> = {}) => ({
  id: 'server-assigned-ignored',
  amount: 26.32,
  status: 'pending_review',
  purchaseOrderNumber: null,
  ...overrides,
})

let queueReceiptUpload: typeof import('./crmSync').queueReceiptUpload
let flushReceiptQueue: typeof import('./crmSync').flushReceiptQueue
let pendingReceiptCount: typeof import('./crmSync').pendingReceiptCount
let compressReceiptImage: typeof import('./crmSync').compressReceiptImage
let db: typeof import('../db/database').db

beforeEach(async () => {
  stubBrowser()
  vi.resetModules()
  const crmSync = await import('./crmSync')
  queueReceiptUpload = crmSync.queueReceiptUpload
  flushReceiptQueue = crmSync.flushReceiptQueue
  pendingReceiptCount = crmSync.pendingReceiptCount
  compressReceiptImage = crmSync.compressReceiptImage
  db = (await import('../db/database')).db
  await db.open()
  await db.receiptSyncQueue.clear()
  await db.photos.clear()
})

afterEach(async () => {
  db.close()
  await (await import('dexie')).default.delete('red-cedar-health-record')
  vi.unstubAllGlobals()
})

// The vitest project for field/ runs in the default 'node' environment (see
// crmSync.assignments.test.ts / crmSync.enrollment.test.ts, which stub the
// browser globals by hand rather than pulling in jsdom). Neither
// createImageBitmap nor OffscreenCanvas/document exist here, so
// compressReceiptImage's try branch always throws and its catch branch
// always returns the original blob unchanged — this IS the "compression
// unavailable" fallback path in production code, not a mock standing in for
// it, which is why case 5 below needs no special setup.

describe('compressReceiptImage', () => {
  it('falls back to the original blob when no compression API exists in this runtime', async () => {
    const original = new Blob(['x'.repeat(1000)], { type: 'image/jpeg' })
    const result = await compressReceiptImage(original)
    expect(result.blob).toBe(original)
    expect(result.mimeType).toBe('image/jpeg')
  })

  it('never throws even on a blob with no evident image content', async () => {
    const garbage = new Blob(['not an image'], { type: 'application/octet-stream' })
    await expect(compressReceiptImage(garbage)).resolves.toBeTruthy()
  })
})

describe('queueReceiptUpload — durability', () => {
  it('a failed upload leaves exactly one queue row plus both blobs', async () => {
    mockFetchFailure()
    const blob = new Blob(['receipt-bytes'], { type: 'image/jpeg' })

    const { receiptId } = await queueReceiptUpload({
      visitId: 'v1',
      purchaseOrderId: 'po1',
      blob,
      amount: 26.32,
      vendor: 'Home Depot',
      category: 'materials',
    })
    // queueReceiptUpload fires a flush in the background (`void
    // flushReceiptQueue()`); await one explicitly so the failed attempt has
    // definitely happened before we assert on its aftermath.
    await flushReceiptQueue()

    expect(await db.receiptSyncQueue.count()).toBe(1)
    const row = await db.receiptSyncQueue.get(receiptId)
    expect(row).toBeTruthy()
    expect(row!.attempts).toBeGreaterThan(0)
    expect(row!.lastError).toContain('Network request failed')

    // In this runtime compression always falls back to the original, so the
    // "compressed copy" and "original" are the same blob under one photoId —
    // both blobs, but only one row in db.photos.
    expect(row!.photoId).toBe(row!.originalPhotoId)
    expect(await db.photos.get(row!.originalPhotoId)).toBeTruthy()
    expect(await db.photos.count()).toBe(1)
  })

  it('a later flush sends the queued receipt and clears its row and blobs', async () => {
    mockFetchFailure()
    const blob = new Blob(['receipt-bytes-2'], { type: 'image/jpeg' })
    const { receiptId } = await queueReceiptUpload({ blob, purchaseOrderId: 'po2', category: 'materials' })
    await flushReceiptQueue()
    expect(await db.receiptSyncQueue.count()).toBe(1)

    mockFetchOk(receiptResponse())
    const result = await flushReceiptQueue()

    expect(result.pushed).toBe(1)
    expect(result.remaining).toBe(0)
    expect(await db.receiptSyncQueue.get(receiptId)).toBeUndefined()
    expect(await db.photos.count()).toBe(0)
    expect(await pendingReceiptCount()).toBe(0)
  })

  it('two flushes produce one server call per receipt with a stable receiptId', async () => {
    // Keep the internal `void flushReceiptQueue()` fired by queueReceiptUpload
    // from racing the explicit flush below by having it fail first (harmless —
    // just an attempts/lastError bump) before the mock switches to success.
    mockFetchFailure()
    const blob = new Blob(['receipt-bytes-3'], { type: 'image/jpeg' })
    await queueReceiptUpload({ blob, visitId: 'v3', category: 'materials' })
    await flushReceiptQueue()

    const fetchMock = mockFetchOk(receiptResponse())
    const first = await flushReceiptQueue()
    expect(first.pushed).toBe(1)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const [urlCalled] = fetchMock.mock.calls[0] as [string]
    const receiptIdInUrl = urlCalled.match(/\/receipts\/([a-f0-9]+)\?/)?.[1]
    expect(receiptIdInUrl).toBeTruthy()

    // The second flush must be a no-op: the row is already gone, so it must
    // NOT re-upload — still exactly one server call for this receipt.
    const second = await flushReceiptQueue()
    expect(second.pushed).toBe(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // A second receipt's id must stay stable across its own retry too — the
    // same id is what makes a retry land on the same server-side row.
    mockFetchFailure()
    const { receiptId } = await queueReceiptUpload({ blob: new Blob(['x']), category: 'materials' })
    await flushReceiptQueue()
    const rowAfterFailure = await db.receiptSyncQueue.get(receiptId)
    expect(rowAfterFailure!.receiptId).toBe(receiptId)

    const secondFetch = mockFetchOk(receiptResponse())
    await flushReceiptQueue()
    expect(secondFetch).toHaveBeenCalledTimes(1)
    const [secondUrl] = secondFetch.mock.calls[0] as [string]
    expect(secondUrl).toContain(`/receipts/${receiptId}?`)
  })

  it('a fresh db instance (simulating an app restart) still finds the queued receipt', async () => {
    mockFetchFailure()
    const blob = new Blob(['receipt-bytes-4'], { type: 'image/jpeg' })
    const { receiptId } = await queueReceiptUpload({ blob, visitId: 'v4', category: 'gas' })
    await flushReceiptQueue()
    expect(await db.receiptSyncQueue.get(receiptId)).toBeTruthy()

    // Simulate a restart: close this handle, reopen a brand new Dexie instance
    // against the same underlying IndexedDB database, exactly as main.tsx does
    // on next launch before calling flushReceiptQueue().
    db.close()
    vi.resetModules()
    stubBrowser()
    mockFetchFailure()
    const fresh = await import('../db/database')
    await fresh.db.open()

    const row = await fresh.db.receiptSyncQueue.get(receiptId)
    expect(row).toBeTruthy()
    expect(row!.visitId).toBe('v4')
    expect(await fresh.db.photos.get(row!.originalPhotoId)).toBeTruthy()

    db = fresh.db
  })

  it('a compression failure still queues and uploads the original', async () => {
    // In this vitest environment createImageBitmap/OffscreenCanvas/document do
    // not exist, so compressReceiptImage's try branch always throws — this
    // exercises the real fallback path, not a substitute for it. Fail the
    // internal auto-flush first so it can't race the explicit one below.
    mockFetchFailure()
    const original = new Blob(['full-resolution-original'], { type: 'image/jpeg' })
    const { receiptId } = await queueReceiptUpload({ blob: original, purchaseOrderId: 'po5', amount: 214.43 })
    await flushReceiptQueue()

    const fetchMock = mockFetchOk(receiptResponse({ amount: 214.43 }))
    await flushReceiptQueue()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    // Round-tripped through fake-indexeddb, so it's a distinct Blob instance
    // with the same bytes — content equality is what actually matters here:
    // the ORIGINAL (not a re-derived "compressed" copy) is what went over the wire.
    expect(await (init.body as Blob).text()).toBe(await original.text())
    expect((init.body as Blob).size).toBe(original.size)
    expect(await db.receiptSyncQueue.get(receiptId)).toBeUndefined()
  })

  it('keeps the row visible with an explicit error when both blobs are gone from this device', async () => {
    // Reachable in practice: a browser can evict IndexedDB under storage
    // pressure. This must NOT reproduce the 2026-09-11 defect (a receipt
    // vanishing with nothing anywhere recording that it did) — the row stays,
    // marked so pendingReceiptCount() surfaces it instead of it disappearing.
    mockFetchFailure()
    const blob = new Blob(['evicted-receipt'], { type: 'image/jpeg' })
    const { receiptId } = await queueReceiptUpload({ blob, category: 'materials' })
    await flushReceiptQueue()

    const row = await db.receiptSyncQueue.get(receiptId)
    expect(row).toBeTruthy()
    await db.photos.delete(row!.photoId)
    if (row!.originalPhotoId !== row!.photoId) await db.photos.delete(row!.originalPhotoId)
    expect(await db.photos.count()).toBe(0)

    // Even with a healthy network, there is nothing left to send.
    const fetchMock = mockFetchOk(receiptResponse())
    const result = await flushReceiptQueue()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(result.pushed).toBe(0)
    expect(await pendingReceiptCount()).toBe(1)
    const stillThere = await db.receiptSyncQueue.get(receiptId)
    expect(stillThere).toBeTruthy()
    expect(stillThere!.lastError).toMatch(/no longer on this device/i)
    expect(stillThere!.attempts).toBeGreaterThan(0)
  })

  it('two concurrent flushReceiptQueue() calls produce one server call per receipt', async () => {
    // queueReceiptUpload's own `void flushReceiptQueue()`, main.tsx on
    // startup, the `online` listener, and queueReceiptAndReport's explicit
    // call can all overlap in time. Without a guard, two overlapping passes
    // would both read the pending row before either deletes it and PUT twice
    // — harmless to data (server upserts on receiptId) but not free: a second
    // upload on a metered connection plus a second inline Vision call.
    mockFetchFailure()
    const blob = new Blob(['concurrent-receipt'], { type: 'image/jpeg' })
    await queueReceiptUpload({ blob, category: 'materials' })
    await flushReceiptQueue() // let the internal auto-flush fail and settle first

    const fetchMock = mockFetchOk(receiptResponse())
    // Called back-to-back with no await between them, so the second call must
    // observe the first's in-flight guard rather than starting its own pass.
    const [a, b] = await Promise.all([flushReceiptQueue(), flushReceiptQueue()])

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(a).toEqual(b)
    expect(a.pushed).toBe(1)
    expect(await pendingReceiptCount()).toBe(0)
  })
})

describe('pendingReceiptCount', () => {
  it('is zero with nothing queued and reflects rows added and cleared', async () => {
    expect(await pendingReceiptCount()).toBe(0)

    mockFetchFailure()
    await queueReceiptUpload({ blob: new Blob(['a']), category: 'materials' })
    await flushReceiptQueue()
    expect(await pendingReceiptCount()).toBe(1)

    mockFetchOk(receiptResponse())
    await flushReceiptQueue()
    expect(await pendingReceiptCount()).toBe(0)
  })
})
