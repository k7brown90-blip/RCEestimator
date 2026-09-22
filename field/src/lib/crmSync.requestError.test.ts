/**
 * Field fix batch (2026-09-21), item 4 — the issue-refusal list.
 *
 * QuoteScreen.tsx reads `err.body.reasons` when POST .../issue 409s with
 * `{ success: false, error: {...}, reasons: [...] }`, but crmRequest threw a
 * plain Error with no body, so the list never rendered — the tech saw a
 * generic message with no idea what to fix. crmRequest now throws
 * CrmRequestError, which carries the parsed body through.
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

function mockFetchRefusal(body: unknown, status = 409) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: () => Promise.resolve(body),
  }))
}

let issueQuote: typeof import('./crmSync').issueQuote
let CrmRequestError: typeof import('./crmSync').CrmRequestError

beforeEach(async () => {
  stubBrowser()
  vi.resetModules()
  const crmSync = await import('./crmSync')
  issueQuote = crmSync.issueQuote
  CrmRequestError = crmSync.CrmRequestError
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('crmRequest error body', () => {
  it('carries the server refusal body through as err.body, reasons included', async () => {
    mockFetchRefusal({
      success: false,
      error: { code: 'not_ready', message: 'a AI-proposed line(s) are still unconfirmed.' },
      reasons: ['A price gap needs a value.', 'Unconfirmed lines need review.'],
    })

    let caught: unknown
    try {
      await issueQuote('draft-1')
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(CrmRequestError)
    const err = caught as InstanceType<typeof CrmRequestError>
    expect(err.message).toBe('a AI-proposed line(s) are still unconfirmed.')
    const body = (err as { body?: { reasons?: string[] } }).body
    expect(body?.reasons).toEqual(['A price gap needs a value.', 'Unconfirmed lines need review.'])
  })

  it('still falls back to a generic message when the server sends no error body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 500, json: () => Promise.reject(new Error('no body')) }))

    let caught: unknown
    try {
      await issueQuote('draft-1')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).toContain('500')
  })
})
