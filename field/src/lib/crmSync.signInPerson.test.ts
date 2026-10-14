/**
 * Signing in person from the phone (Phase 3 unit C, 2026-10-08): the request shape, and that a
 * server refusal reaches the caller as a readable error. ONE request with no queue of its own -
 * since Phase 7 U8 (2026-10-10) lib/signatureQueue.ts owns the row on the phone and calls this to
 * send it, carrying the capture fields (the id the phone minted, its clock, the revision, the
 * server's figures key and the consent sentence) so a resend lands on the one row the office wrote.
 * A signature is a legal record: the screen says "Signed" only on the office's 2xx.
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

let crmSync: typeof import('./crmSync')

beforeEach(async () => {
  stubBrowser()
  vi.resetModules()
  crmSync = await import('./crmSync')
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('signEstimateInPerson', () => {
  it('POSTs the name, the drawing and the ticked options to the tech sign-in-person route, with the tech token', async () => {
    const data = {
      signed: true, estimateId: 'est-1', number: '2026-1098', selectedOptions: ['A'], total: 950,
      jobVisitId: 'job-1', jobJoined: false, archivedNumbers: [],
    }
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 201, json: () => Promise.resolve({ success: true, data }) })
    vi.stubGlobal('fetch', fetchMock)

    const r = await crmSync.signEstimateInPerson('est-1', { signerName: 'Mrs Panel', signatureImage: 'data:image/png;base64,AAAA', selectedOptions: ['A'] })

    expect(r).toEqual(data)
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://rce.example.com/api/health-record/issued-estimates/est-1/sign-in-person')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok')
    expect(JSON.parse(String(init.body))).toEqual({ signerName: 'Mrs Panel', signatureImage: 'data:image/png;base64,AAAA', selectedOptions: ['A'] })
  })

  it('a refusal reaches the screen with the server\'s own sentence (signed once, expired, closed...)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ success: false, error: { code: 'not_signed', message: 'This estimate has already been signed.' } }),
    }))
    await expect(
      crmSync.signEstimateInPerson('est-1', { signerName: 'Mrs Panel', signatureImage: 'x', selectedOptions: ['A'] }),
    ).rejects.toThrow('This estimate has already been signed.')
  })

  it('a stranger tech\'s 403 is a readable error, not a signed state', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      json: () => Promise.resolve({ success: false, error: { code: 'forbidden', message: 'This estimate is not on one of your visits' } }),
    }))
    await expect(
      crmSync.signEstimateInPerson('est-9', { signerName: 'Mrs Panel', signatureImage: 'x', selectedOptions: ['A'] }),
    ).rejects.toThrow('This estimate is not on one of your visits')
  })

  it('the capture fields ride in the same body, exactly as given (Phase 7 U7/U8): the phone computes none of them', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 201, json: () => Promise.resolve({ success: true, data: { signed: true } }) })
    vi.stubGlobal('fetch', fetchMock)
    const capture = {
      clientSignatureId: '7b3d5c1e-5f3a-4c1b-9d2e-0a1b2c3d4e5f',
      capturedAt: '2026-10-10T14:14:00.000Z',
      sentAt: '2026-10-10T16:02:00.000Z',
      heldOnPhone: true,
      revision: 2,
      figuresKey: 'f'.repeat(64),
      consentText: 'By typing my full name and tapping Accept & Sign, I agree.',
    }
    await crmSync.signEstimateInPerson('est-1', { signerName: 'Mrs Panel', signatureImage: 'x', selectedOptions: ['A'], ...capture })
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({ signerName: 'Mrs Panel', signatureImage: 'x', selectedOptions: ['A'], ...capture })
  })
})

describe('fileSignatureEvent (Phase 7 U8): a cancelled or dismissed phone signature is filed at the office, never as a signature', () => {
  it('POSTs the event to the signature-events route with the tech token, and the drawn mark never goes with it', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({ success: true, data: { filed: true, duplicate: false } }) })
    vi.stubGlobal('fetch', fetchMock)
    const r = await crmSync.fileSignatureEvent('est-1', { signatureId: 'sig-1', event: 'dismissed', reason: 'Called her', signerName: 'Mrs Panel', capturedAt: '2026-10-10T14:14:00.000Z', refusal: 'This estimate is void.' })
    expect(r).toEqual({ filed: true, duplicate: false })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://rce.example.com/api/health-record/issued-estimates/est-1/signature-events')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok')
    const body = JSON.parse(String(init.body))
    expect(body).toEqual({ signatureId: 'sig-1', event: 'dismissed', reason: 'Called her', signerName: 'Mrs Panel', capturedAt: '2026-10-10T14:14:00.000Z', refusal: 'This estimate is void.' })
    expect(body).not.toHaveProperty('signatureImage')
  })
})
