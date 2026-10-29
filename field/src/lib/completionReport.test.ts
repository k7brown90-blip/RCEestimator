/**
 * The Job completion report, field door (Kyle, 2026-10-29): the technician's Save / Clear / Add
 * photo on the Job site screen go to the SAME records the office edits in the CRM.
 *
 * Pinned here: a Save sends the edited entry to PUT /visits/:id/completion-lines/:lineId; Clear
 * calls DELETE; a photo added from the report goes up through the existing job-photo upload and its
 * id lands on the line; a refusal shows the server's own words; with no signal the tech is told so.
 */

import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CompletionLineView } from '../../../shared/jobCompletion'

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

function lastCall(fetchMock: ReturnType<typeof vi.fn>) {
  const [url, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [string, RequestInit]
  return { url, init, method: init.method, body: typeof init.body === 'string' ? (JSON.parse(init.body) as unknown) : null }
}

const line = (over: Partial<CompletionLineView> = {}): CompletionLineView => ({
  lineId: 'line-1',
  documentId: 'doc-1',
  documentNumber: '2026-1122',
  documentKind: 'invoice',
  option: 'A',
  name: 'Replace 20A GFCI receptacle',
  quantity: 2,
  defaultNecRefs: ['210.8(A)'],
  entry: null,
  ...over,
})

const savedEntry = {
  explanation: 'Old one tripped; replaced and tested.',
  necRefs: ['210.8(A)(2)'],
  readings: [{ label: 'Voltage', value: '121', unit: 'V' }],
  photoIds: ['p-1'],
  updatedBy: 'tech:t1',
  updatedAt: '2026-10-29T15:00:00.000Z',
}

let crmSync: typeof import('./crmSync')
let report: typeof import('./completionReport')

beforeEach(async () => {
  stubBrowser()
  vi.resetModules()
  crmSync = await import('./crmSync')
  report = await import('./completionReport')
})
afterEach(() => {
  vi.unstubAllGlobals()
})

describe('opening a line', () => {
  it("a line with no entry starts from the price book's NEC article", () => {
    expect(report.draftFromLine(line())).toEqual({ explanation: '', necRefs: ['210.8(A)'], readings: [], photoIds: [] })
  })
  it('a saved entry shows what was saved - and a saved "no article" stays empty, not re-filled', () => {
    const d = report.draftFromLine(line({ entry: { ...savedEntry, necRefs: [] } }))
    expect(d.necRefs).toEqual([])
    expect(d.explanation).toBe(savedEntry.explanation)
    expect(d.photoIds).toEqual(['p-1'])
  })
  it('"N of M lines written up" counts the lines that have an entry', () => {
    const lines = [line({ lineId: 'a', entry: savedEntry }), line({ lineId: 'b' }), line({ lineId: 'c' })]
    expect(report.writtenUpWords(lines)).toBe('1 of 3 lines written up')
    expect(report.writtenUpWords([line()])).toBe('0 of 1 line written up')
  })
})

describe('Save', () => {
  it('sends the edited entry to PUT completion-lines/:lineId - trimmed, blank articles and blank reading rows dropped', async () => {
    const f = mockFetchOk(line({ entry: savedEntry }))
    const draft = {
      explanation: '  Replaced the GFCI and tested it.  ',
      necRefs: ['210.8(A)', '  ', '406.4(D)(4) '],
      readings: [{ label: ' Voltage ', value: '121', unit: ' V ' }, { label: '', value: '', unit: '' }],
      photoIds: ['p-1'],
    }
    expect(report.saveBlockReason(draft)).toBeNull()
    const saved = await crmSync.saveCompletionLine('visit-1', 'line-1', report.bodyFromDraft(draft))
    expect(lastCall(f)).toMatchObject({
      url: 'https://rce.example.com/api/health-record/visits/visit-1/completion-lines/line-1',
      method: 'PUT',
      body: {
        explanation: 'Replaced the GFCI and tested it.',
        necRefs: ['210.8(A)', '406.4(D)(4)'],
        readings: [{ label: 'Voltage', value: '121', unit: 'V' }],
        photoIds: ['p-1'],
      },
    })
    expect((lastCall(f).init.headers as Record<string, string>).Authorization).toBe('Bearer tok')
    expect(saved.entry?.photoIds).toEqual(['p-1'])
  })

  it('is greyed WITH a reason when there is nothing to save, or a reading is half filled', () => {
    expect(report.saveBlockReason({ explanation: ' ', necRefs: ['210.8(A)'], readings: [], photoIds: [] })).toMatch(/Write what was done/)
    expect(report.saveBlockReason({ explanation: 'x', necRefs: [], readings: [{ label: 'Voltage', value: '', unit: 'V' }], photoIds: [] })).toMatch(/needs a label and a value/)
    // a photo alone is enough, like the server's rule
    expect(report.saveBlockReason({ explanation: '', necRefs: [], readings: [], photoIds: ['p-1'] })).toBeNull()
  })

  it("a refusal shows the server's own message", async () => {
    const message = "A photo you picked is not on this job. Only this job's own photos can go on its completion report."
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ success: false, error: { code: 'bad_request', message } }),
    }))
    const err = await crmSync.saveCompletionLine('visit-1', 'line-1', { explanation: 'x' }).catch((e: unknown) => e)
    expect(report.completionFailureWords(err, 'save')).toBe(message)
  })

  it('with no signal says so - and does not claim it saved', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    const err = await crmSync.saveCompletionLine('visit-1', 'line-1', { explanation: 'x' }).catch((e: unknown) => e)
    expect(report.completionFailureWords(err, 'save')).toBe('No signal — save again when you have signal.')
    expect(report.completionFailureWords(err, 'photo')).toBe('No signal — add the photo again when you have signal.')
    expect(report.completionFailureWords(err, 'load')).toMatch(/^No signal — the completion report needs signal to open/)
  })
})

describe('Clear', () => {
  it('calls DELETE completion-lines/:lineId', async () => {
    const f = mockFetchOk({ cleared: true })
    await expect(crmSync.clearCompletionLine('visit-1', 'line-1')).resolves.toEqual({ cleared: true })
    expect(lastCall(f)).toMatchObject({
      url: 'https://rce.example.com/api/health-record/visits/visit-1/completion-lines/line-1',
      method: 'DELETE',
    })
  })
})

describe('the lines list', () => {
  it('GETs completion-lines and hands back the lines and the "no signed invoice" reason', async () => {
    const data = { visitId: 'visit-1', invoiceNumber: null, lines: [], writtenUp: 0, reason: 'No signed invoice on this job yet' }
    const f = mockFetchOk(data)
    await expect(crmSync.fetchCompletionLines('visit-1')).resolves.toEqual(data)
    expect(lastCall(f)).toMatchObject({ url: 'https://rce.example.com/api/health-record/visits/visit-1/completion-lines', method: 'GET' })
  })
})

describe('Add photo', () => {
  it("goes up through the existing job-photo upload and the new photo's id lands on the line", async () => {
    const f = mockFetchOk({ id: 'whatever', sizeBytes: 3 }, 201)
    const draft = { explanation: 'x', necRefs: [], readings: [], photoIds: ['p-1'] }
    const next = await report.addPhotoToDraft('visit-1', new Blob(['abc'], { type: 'image/jpeg' }), draft, 'after')
    const call = lastCall(f)
    expect(call.method).toBe('PUT')
    const m = /\/visits\/visit-1\/photos\/([0-9a-f-]{36})$/.exec(call.url)
    expect(m).not.toBeNull()
    const uploadedId = m![1]
    expect(next.photoIds).toEqual(['p-1', uploadedId])
    expect((call.init.headers as Record<string, string>)['x-photo-caption']).toBe('after')
  })

  it('uploadJobPhoto resolves to the photo id (existing callers ignore it)', async () => {
    mockFetchOk({}, 201)
    const id = await crmSync.uploadJobPhoto('visit-1', new Blob(['abc'], { type: 'image/jpeg' }))
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('a failed upload puts nothing on the line', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, json: () => Promise.resolve(null) }))
    await expect(
      report.addPhotoToDraft('visit-1', new Blob(['abc']), { explanation: '', necRefs: [], readings: [], photoIds: [] }),
    ).rejects.toThrow(/Photo upload failed/)
  })

  it('refuses a ninth photo with the reason, before uploading anything', async () => {
    const f = mockFetchOk({}, 201)
    const full = { explanation: 'x', necRefs: [], readings: [], photoIds: Array.from({ length: 8 }, (_, i) => `p-${i}`) }
    await expect(report.addPhotoToDraft('visit-1', new Blob(['abc']), full)).rejects.toThrow(/at most 8 photos/)
    expect(f).not.toHaveBeenCalled()
  })
})

describe("this job's photos (the picker)", () => {
  it("lists the visit's photos from GET /visits/:id/photos - no image bytes in the answer", async () => {
    const photos = [{ id: 'p-1', caption: 'before', tag: null, uploadedAt: '2026-10-29T14:00:00.000Z' }]
    const f = mockFetchOk({ photos })
    await expect(crmSync.fetchVisitPhotos('visit-1')).resolves.toEqual(photos)
    expect(lastCall(f)).toMatchObject({ url: 'https://rce.example.com/api/health-record/visits/visit-1/photos', method: 'GET' })
  })

  it('fetches a thumbnail with the bearer HEADER - the token is never in the URL', async () => {
    const blob = new Blob(['jpeg'], { type: 'image/jpeg' })
    const f = vi.fn().mockResolvedValue({ ok: true, status: 200, blob: () => Promise.resolve(blob) })
    vi.stubGlobal('fetch', f)
    await expect(crmSync.fetchVisitPhotoThumb('visit-1', 'p-1')).resolves.toBe(blob)
    const [url, init] = f.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://rce.example.com/api/health-record/visits/visit-1/photos/p-1/image?size=thumb')
    expect(url).not.toContain('tok')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok')
  })

  it('a thumbnail the office refuses (404) throws, so the screen shows "no preview"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404 }))
    await expect(crmSync.fetchVisitPhotoThumb('visit-1', 'nope')).rejects.toThrow("Photo preview failed (404)")
  })

  it('with no signal the picker says so', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')))
    const err = await crmSync.fetchVisitPhotos('visit-1').catch((e: unknown) => e)
    expect(report.completionFailureWords(err, 'list')).toBe("No signal — this job's photos can't be listed until you have signal.")
  })
})
