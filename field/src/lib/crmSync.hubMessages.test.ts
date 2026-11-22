/**
 * The field's Messages calls (work order agent-team, U5/U6/U7): the request shapes onto the technician's own
 * routes (/api/health-record/hub/...). The bearer rides the Authorization header and never the address; a
 * Team photo goes as the raw image; the stream is asked for with a header, not a token in the URL.
 */

import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

function stubBrowser() {
  const store = new Map<string, string>([
    ['rce_crm_base_url', 'https://rce.example.com'],
    ['rce_crm_tech_token', 'secret-tech-token'],
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
  return { url, init, method: init.method, headers: init.headers as Record<string, string>, body: typeof init.body === 'string' ? JSON.parse(init.body) as unknown : init.body }
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

const BASE = 'https://rce.example.com/api/health-record/hub'

describe('reading', () => {
  it('lists the threads, reads the badge, opens a job thread and one thread, all with the bearer in the header', async () => {
    const f = mockFetchOk({ threads: [], unread: 0 })
    await crmSync.fetchHubThreads()
    expect(lastCall(f)).toMatchObject({ url: `${BASE}/threads`, method: 'GET' })
    expect(lastCall(f).headers.Authorization).toBe('Bearer secret-tech-token')
    await crmSync.fetchHubBadge()
    expect(lastCall(f).url).toBe(`${BASE}/badge`)
    await crmSync.openJobThread('visit 1')
    expect(lastCall(f)).toMatchObject({ url: `${BASE}/job/visit%201/thread`, method: 'POST' })
    await crmSync.fetchHubThread('t1')
    expect(lastCall(f).url).toBe(`${BASE}/threads/t1/messages`)
    for (const [url] of f.mock.calls as Array<[string]>) expect(url).not.toContain('secret-tech-token')
  })
})

describe('writing', () => {
  it('sends, edits, deletes (with and without a reason) and marks read', async () => {
    const f = mockFetchOk({ id: 'm1' })
    await crmSync.sendHubMessage('t1', { body: 'On site' })
    expect(lastCall(f)).toMatchObject({ url: `${BASE}/threads/t1/messages`, method: 'POST', body: { body: 'On site' } })
    await crmSync.sendHubMessage('t1', { body: '', photoIds: ['p1'], attachmentIds: ['a1'] })
    expect(lastCall(f).body).toEqual({ body: '', photoIds: ['p1'], attachmentIds: ['a1'] })
    await crmSync.editHubMessage('m1', 'Panel is open')
    expect(lastCall(f)).toMatchObject({ url: `${BASE}/messages/m1`, method: 'PATCH', body: { body: 'Panel is open' } })
    await crmSync.deleteHubMessage('m1')
    expect(lastCall(f)).toMatchObject({ url: `${BASE}/messages/m1`, method: 'DELETE', body: {} })
    await crmSync.deleteHubMessage('m1', 'wrong job')
    expect(lastCall(f).body).toEqual({ reason: 'wrong job' })
    await crmSync.markHubThreadRead('t1')
    expect(lastCall(f)).toMatchObject({ url: `${BASE}/threads/t1/read`, method: 'POST' })
  })

  it('sends a Team photo as the raw image, and can take it back', async () => {
    const f = mockFetchOk({ id: 'a1', mimeType: 'image/jpeg' })
    const picture = new Blob(['jpegbytes'], { type: 'image/jpeg' })
    await expect(crmSync.uploadHubAttachment('t1', picture)).resolves.toEqual({ id: 'a1', mimeType: 'image/jpeg' })
    const call = lastCall(f)
    expect(call.url).toBe(`${BASE}/threads/t1/attachments`)
    expect(call.method).toBe('POST')
    expect(call.headers['Content-Type']).toBe('image/jpeg')
    expect(call.init.body).toBe(picture)
    await crmSync.removeHubAttachment('a1')
    expect(lastCall(f)).toMatchObject({ url: `${BASE}/attachments/a1`, method: 'DELETE' })
  })

  it('reads a Team photo with the bearer, never from an address that carries it', async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, status: 200, blob: () => Promise.resolve(new Blob(['x'])) })
    vi.stubGlobal('fetch', f)
    await crmSync.fetchHubAttachment('a1')
    const [url, init] = f.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${BASE}/attachments/a1`)
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer secret-tech-token')
    expect(url).not.toContain('secret-tech-token')
  })
})

describe('the live stream and notifications', () => {
  it('asks for the stream with the token in a header and none in the address, and nothing when not connected', async () => {
    const request = crmSync.hubStreamRequest()
    expect(request?.url).toBe(`${BASE}/stream`)
    expect(request?.headers()).toEqual({ Authorization: 'Bearer secret-tech-token' })
    expect(request?.url).not.toContain('secret-tech-token')
    localStorage.removeItem('rce_crm_tech_token')
    expect(crmSync.hubStreamRequest()).toBeNull()
  })

  it('turns notifications on and off through the technician routes', async () => {
    const f = mockFetchOk({ configured: true, publicKey: 'BKey', reason: null, subscribed: false })
    await crmSync.fetchHubPushKey()
    expect(lastCall(f)).toMatchObject({ url: `${BASE}/push/key`, method: 'GET' })
    await crmSync.subscribeHubPush({ endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'a', auth: 'b' } })
    expect(lastCall(f)).toMatchObject({ url: `${BASE}/push/subscription`, method: 'POST', body: { endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'a', auth: 'b' } } })
    await crmSync.unsubscribeHubPush('https://fcm.googleapis.com/x')
    expect(lastCall(f)).toMatchObject({ method: 'DELETE', body: { endpoint: 'https://fcm.googleapis.com/x' } })
  })

  it('asks whether THIS device is on for this technician with the address in the body, never in the URL', async () => {
    const f = mockFetchOk({ subscribedHere: true })
    await expect(crmSync.fetchHubPushHere('https://fcm.googleapis.com/secret-device')).resolves.toBe(true)
    const call = lastCall(f)
    expect(call).toMatchObject({ url: `${BASE}/push/subscription/status`, method: 'POST', body: { endpoint: 'https://fcm.googleapis.com/secret-device' } })
    expect(call.url).not.toContain('secret-device')
    mockFetchOk({ subscribedHere: false })
    await expect(crmSync.fetchHubPushHere('https://fcm.googleapis.com/other')).resolves.toBe(false)
  })

  it('says whether the server removed a device, so the phone keeps a subscription that is not its own', async () => {
    mockFetchOk({ subscribed: false, removed: false })
    await expect(crmSync.unsubscribeHubPush('https://fcm.googleapis.com/shared')).resolves.toEqual({ subscribed: false, removed: false })
  })
})

describe('a job photo that is sent again is the same photo', () => {
  it('uses the id it is given, so a retry updates the one VisitPhoto instead of filing another; with none given each upload is new', async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) })
    vi.stubGlobal('fetch', f)
    const picture = new Blob(['jpegbytes'], { type: 'image/jpeg' })
    const first = await crmSync.uploadJobPhoto('visit-1', picture, undefined, 'stable-photo-id')
    const again = await crmSync.uploadJobPhoto('visit-1', picture, undefined, 'stable-photo-id')
    expect(first).toBe('stable-photo-id')
    expect(again).toBe('stable-photo-id')
    const urls = (f.mock.calls as Array<[string]>).map((c) => c[0])
    expect(urls).toEqual([
      'https://rce.example.com/api/health-record/visits/visit-1/photos/stable-photo-id',
      'https://rce.example.com/api/health-record/visits/visit-1/photos/stable-photo-id',
    ])
    const a = await crmSync.uploadJobPhoto('visit-1', picture)
    const b = await crmSync.uploadJobPhoto('visit-1', picture)
    expect(a).not.toBe(b)
  })
})
