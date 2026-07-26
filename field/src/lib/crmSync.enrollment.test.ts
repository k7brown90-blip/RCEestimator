import { beforeEach, describe, expect, it, vi } from 'vitest'
import { consumeEnrollmentToken, getCrmSettings } from './crmSync'

// Minimal browser surface — the field project runs vitest in the node
// environment, so localStorage/history/location are stubbed here rather than
// pulling in jsdom for four globals.
function stubBrowser(hash: string) {
  const store = new Map<string, string>()
  const replaceState = vi.fn()

  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  })
  vi.stubGlobal('history', { replaceState })
  vi.stubGlobal('window', {
    location: { hash, origin: 'https://rce.example.com', pathname: '/field/', search: '' },
  })

  return { store, replaceState }
}

describe('consumeEnrollmentToken', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
  })

  it('saves the token from the URL fragment and reports enrollment', () => {
    const { store } = stubBrowser('#t=abc123token')

    expect(consumeEnrollmentToken()).toBe(true)
    expect(store.get('rce_crm_tech_token')).toBe('abc123token')
    // baseUrl defaults to the origin we were served from
    expect(store.get('rce_crm_base_url')).toBe('https://rce.example.com')
    expect(getCrmSettings()).toEqual({
      baseUrl: 'https://rce.example.com',
      token: 'abc123token',
    })
  })

  it('strips the fragment so the token does not linger in history', () => {
    const { replaceState } = stubBrowser('#t=abc123token')

    consumeEnrollmentToken()

    expect(replaceState).toHaveBeenCalledWith(null, '', '/field/')
  })

  it('percent-decodes tokens containing URL-unsafe characters', () => {
    const { store } = stubBrowser(`#t=${encodeURIComponent('a+b/c=d')}`)

    expect(consumeEnrollmentToken()).toBe(true)
    expect(store.get('rce_crm_tech_token')).toBe('a+b/c=d')
  })

  it('overwrites an existing token — re-scanning moves the device', () => {
    const { store } = stubBrowser('#t=newtoken')
    store.set('rce_crm_tech_token', 'oldtoken')

    expect(consumeEnrollmentToken()).toBe(true)
    expect(store.get('rce_crm_tech_token')).toBe('newtoken')
  })

  it('is a no-op on a normal launch with no fragment', () => {
    const { store, replaceState } = stubBrowser('')

    expect(consumeEnrollmentToken()).toBe(false)
    expect(store.size).toBe(0)
    expect(replaceState).not.toHaveBeenCalled()
  })

  it('ignores an unrelated fragment without touching the URL', () => {
    const { store, replaceState } = stubBrowser('#some-anchor')

    expect(consumeEnrollmentToken()).toBe(false)
    expect(store.size).toBe(0)
    expect(replaceState).not.toHaveBeenCalled()
  })

  it('clears an empty t= rather than leaving a partial credential in the bar', () => {
    const { store, replaceState } = stubBrowser('#t=')

    expect(consumeEnrollmentToken()).toBe(false)
    expect(store.size).toBe(0)
    expect(replaceState).toHaveBeenCalled()
  })
})
