/**
 * "Accept & Sign" on the technician's phone (Phase 3 unit C, 2026-10-08). Rendered to static markup
 * (the field suite runs in node with no DOM), plus the pure submit rules behind the button.
 *
 * What these pin:
 *   - the consent sentence on the screen is the string the server records (shared/consentText);
 *   - the checks mirror the CRM's signing screen (a name, the tick, a drawn mark) and NOTHING is posted
 *     until they pass; the server's refusal comes back to the screen word for word;
 *   - the total on the screen and on the signed view are figures handed in (the server's table lookup /
 *     the server's signed total) - the screen adds nothing up;
 *   - no labour / cost / margin / rate / token appears on a page the customer is holding;
 *   - the signed view says Signed, names the options and the total, and leaves by "Back to the job".
 */

import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { SignInPersonScreen, SignedView, optionsLabel, signingProblem, submitSignature } from './SignInPersonScreen'
import type { InPersonSignResult } from '../../lib/crmSync'
import { CONSENT_TEXT } from '../../../../shared/consentText'

const result = (over: Partial<InPersonSignResult> = {}): InPersonSignResult => ({
  signed: true,
  estimateId: 'est-1',
  number: '2026-1098',
  selectedOptions: ['A', 'B'],
  total: 1406,
  jobVisitId: 'job-1',
  jobJoined: false,
  archivedNumbers: [],
  ...over,
})

const MARK = 'data:image/png;base64,iVBORw0KGgo='

const screen = (over: Partial<Parameters<typeof SignInPersonScreen>[0]> = {}) =>
  renderToStaticMarkup(
    <SignInPersonScreen
      visitId="visit-1"
      number="2026-1098"
      title="Panel upgrade"
      selectedOptions={['A', 'B']}
      optionNames={{ A: 'Panel', B: null }}
      total={1406}
      onSign={async () => result()}
      onBack={() => {}}
      onBackToJob={() => {}}
      {...over}
    />,
  )

// ─── what the customer reads ─────────────────────────────────────────────────

describe('SignInPersonScreen - what the customer sees', () => {
  it('asks for the four things the office screen asks for, with the button worded like the office screen', () => {
    const html = screen()
    expect(html).toContain('Type your full name to sign')
    expect(html).toContain('Customer signs here') // the finger pad
    expect(html).toContain('type="checkbox"')
    expect(html).toContain('Accept &amp; Sign')
  })

  it('shows the consent sentence the server records, verbatim', () => {
    const html = screen()
    // renderToStaticMarkup escapes; the only character that changes is the "&" in "Accept & Sign".
    expect(html).toContain(CONSENT_TEXT.replace(/&/g, '&amp;'))
    // Ruling 4 (Kyle, 2026-10-09): the exact sentence, "Accept & Sign" inside it (escaped in markup).
    expect(html).toContain(
      'By typing my full name and tapping Accept &amp; Sign, I agree to the scope and the price on this estimate, and I authorize Red Cedar Electric LLC to perform the work described. I understand this is an electronic signature with the same effect as a written one.',
    )
    expect(CONSENT_TEXT).toContain('electronic signature with the same effect as a written one')
  })

  it('shows the estimate, the options being signed and the total handed in (nothing is added up here)', () => {
    const html = screen({ total: 1406 })
    expect(html).toContain('Panel upgrade')
    expect(html).toContain('2026-1098')
    expect(html).toContain('Options A + B')
    expect(html).toContain('Option A — Panel')
    expect(html).toContain('aria-label="Total">$1406.00<')
    // A combination the server did not price shows a dash, never $0.
    expect(screen({ total: null })).toContain('aria-label="Total">—<')
  })

  it('has the technician-only way out in its own strip, and says it needs signal', () => {
    const html = screen()
    expect(html).toContain('Back to the customer&#x27;s quote')
    expect(html).toContain('Needs signal')
  })

  it('carries nothing of Red Cedar\'s: no labour, cost, margin, rate or token words on a page the customer holds', () => {
    const html = screen()
    for (const word of ['hours', 'labor', 'labour', 'margin', 'markup', 'synchrony', 'token', 'unit cost', 'companyCost']) {
      expect(html.toLowerCase(), word).not.toContain(word.toLowerCase())
    }
  })
})

// ─── the button's rules ──────────────────────────────────────────────────────

describe('signingProblem - the office screen\'s own checks, in its own words', () => {
  it('needs a name of two letters, the tick, and a drawn mark, in that order', () => {
    expect(signingProblem({ name: '', agreed: true, signature: MARK })).toBe('Please type your full name.')
    expect(signingProblem({ name: ' A ', agreed: true, signature: MARK })).toBe('Please type your full name.')
    expect(signingProblem({ name: 'Mrs Panel', agreed: false, signature: MARK })).toBe('Please tick the box to agree before signing.')
    expect(signingProblem({ name: 'Mrs Panel', agreed: true, signature: null })).toBe('Please draw your signature in the box.')
    expect(signingProblem({ name: 'Mrs Panel', agreed: true, signature: MARK })).toBeNull()
  })
})

describe('submitSignature - one post, after the checks, with the server\'s answer shown as it came', () => {
  const base = { name: '  Mrs Panel ', agreed: true, signature: MARK, selectedOptions: ['A', 'B'] as ('A' | 'B')[] }

  it('posts NOTHING while a name, the tick or the mark is missing', async () => {
    const onSign = vi.fn()
    for (const bad of [{ name: '' }, { agreed: false }, { signature: null }]) {
      const r = await submitSignature({ ...base, ...bad, onSign })
      expect(r.ok).toBe(false)
    }
    expect(onSign).not.toHaveBeenCalled()
  })

  it('posts once with the trimmed name, the drawing and exactly the ticked options', async () => {
    const onSign = vi.fn().mockResolvedValue(result())
    const r = await submitSignature({ ...base, onSign })
    expect(onSign).toHaveBeenCalledTimes(1)
    expect(onSign).toHaveBeenCalledWith({ signerName: 'Mrs Panel', signatureImage: MARK, selectedOptions: ['A', 'B'] })
    expect(r).toEqual({ ok: true, result: result() })
  })

  it('hands back the server\'s refusal word for word, and stays unsigned', async () => {
    const reason = 'This estimate expired on 9/1/2026 — material prices are no longer guaranteed. Call Red Cedar Electric for a current quote.'
    const onSign = vi.fn().mockRejectedValue(new Error(reason))
    const r = await submitSignature({ ...base, onSign })
    expect(r).toEqual({ ok: false, error: reason })
  })
})

// ─── after the signature ─────────────────────────────────────────────────────

describe('SignedView - Signed, what was agreed, and the way back to the job', () => {
  const view = (r: InPersonSignResult, names: Record<string, string | null> = { A: 'Panel', B: null }) =>
    renderToStaticMarkup(<SignedView result={r} visitId="visit-1" optionNames={names} onBackToJob={() => {}} />)

  it('says Signed with the estimate number, the options taken and the SERVER\'s total', () => {
    const html = view(result({ total: 1406, selectedOptions: ['A', 'B'] }))
    expect(html).toContain('Signed — thank you')
    expect(html).toContain('2026-1098')
    expect(html).toContain('Option A')
    expect(html).toContain('— Panel')
    expect(html).toContain('Option B')
    expect(html).toContain('aria-label="Signed total">$1406.00<')
  })

  it('offers the existing next steps: the deposit (Collect payment) and Back to the job, which leads to Complete work now / Schedule for later', () => {
    const html = view(result())
    expect(html).toContain('Collect payment')
    expect(html).toContain('Back to the job')
    expect(html).toContain('Complete work now')
    expect(html).toContain('Schedule for later')
  })

  it('a change order that joined the current job says there is nothing new to schedule', () => {
    const html = view(result({ jobJoined: true }))
    expect(html).toContain('nothing new to schedule')
    expect(html).not.toContain('Schedule for later')
  })

  it('says which other estimates at the address were put away', () => {
    expect(view(result({ archivedNumbers: ['2026-1050'] }))).toContain('2026-1050')
    expect(view(result({ archivedNumbers: ['2026-1050'] }))).toContain('was put away')
    expect(view(result({ archivedNumbers: ['2026-1050', '2026-1051'] }))).toContain('were put away')
    expect(view(result())).not.toContain('put away')
  })

  it('has no tech-only "back" into the unsigned quote: once signed there is nothing to go back to', () => {
    expect(view(result())).not.toContain('Back to the customer')
  })
})

describe('optionsLabel', () => {
  it('says Option or Options', () => {
    expect(optionsLabel(['A'])).toBe('Option A')
    expect(optionsLabel(['A', 'C'])).toBe('Options A + C')
  })
})
