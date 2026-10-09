/**
 * The Quote screen's lifecycle controls (2026-10-08, one-estimating-system plan, Phase 2 unit B):
 * what the green button says after issue, the title & scope editor, "Edit the estimate", and the
 * two exits. Static renders — the screen is stateful and fetches; these are the pieces a thumb
 * lands on, and every greyed control must carry its reason rather than disappear.
 */

import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { IssuedEstimatePanel, QuoteExits, TitleScopeEditor, ISSUE_LABEL, emailBlockedReason, financingBlockedReason, issueButtonState, issuedHeadline } from './QuoteLifecycle'
import { FIELD_SIGNED_REVISE_REASON, SAVE_CHANGES_LABEL, nothingChangedReason, type DraftLifecycle } from '../../../../shared/draftLifecycle'

// Kyle, 2026-10-09 (ruling 1): changing a signed estimate is OFFICE ONLY - these exact words.
const SIGNED = 'Signed — the office changes a signed estimate; raise a change order for new work'
const LOST = 'Estimate 2026-1098 is marked lost — reopen it before changing or issuing it again.'
const DELETE_REASON = 'Estimate 2026-1098 was issued from this quote, so the quote is its record and stays.'

const issued = (over: Partial<NonNullable<DraftLifecycle['issued']>> = {}): NonNullable<DraftLifecycle['issued']> => ({
  estimateId: 'est-1', number: '2026-1098', revision: 1, status: 'sent', signedAt: null, archived: false,
  customerUrl: 'https://rce.example.com/e/tok', ...over,
})
const lifecycle = (over: Partial<DraftLifecycle> = {}): DraftLifecycle => ({
  status: 'finalized', issued: issued(), hasUnsavedChanges: false, reviseReason: null, deleteReason: DELETE_REASON, copyReason: null, ...over,
})
const noop = async () => {}

describe('issueButtonState — the green button, from the lifecycle alone', () => {
  it('nothing issued: "Issue the estimate", live', () => {
    expect(issueButtonState({ status: 'draft', issued: null, hasUnsavedChanges: false, reviseReason: null, deleteReason: null, copyReason: null }))
      .toEqual({ label: ISSUE_LABEL, disabledReason: null })
    expect(issueButtonState(null).label).toBe(ISSUE_LABEL)
  })
  it('issued and unchanged: "Save changes to the estimate", greyed because nothing changed', () => {
    const s = issueButtonState(lifecycle())
    expect(s.label).toBe(SAVE_CHANGES_LABEL)
    expect(s.disabledReason).toBe(nothingChangedReason({ number: '2026-1098', revision: 1 }))
  })
  it('issued and edited since: "Save changes to the estimate", live', () => {
    expect(issueButtonState(lifecycle({ status: 'draft', hasUnsavedChanges: true }))).toEqual({ label: SAVE_CHANGES_LABEL, disabledReason: null })
  })
  it('signed / lost: greyed with the SERVER\'s sentence, even when the draft was edited', () => {
    expect(issueButtonState(lifecycle({ hasUnsavedChanges: true, reviseReason: SIGNED })).disabledReason).toBe(SIGNED)
    expect(issueButtonState(lifecycle({ hasUnsavedChanges: true, reviseReason: LOST })).disabledReason).toBe(LOST)
  })
})

describe('issuedHeadline', () => {
  it('names the estimate, its revision past the first, and where it stands', () => {
    expect(issuedHeadline(issued())).toBe('Estimate 2026-1098 — issued, not signed yet')
    expect(issuedHeadline(issued({ revision: 3 }))).toBe('Estimate 2026-1098 rev 3 — issued, not signed yet')
    expect(issuedHeadline(issued({ status: 'signed', signedAt: '2026-10-08T12:00:00.000Z' }))).toBe('Estimate 2026-1098 — signed')
    expect(issuedHeadline(issued({ status: 'lost' }))).toBe('Estimate 2026-1098 — marked lost')
  })
})

describe('TitleScopeEditor', () => {
  const render = (lockedReason: string | null = null, scope: string | null = 'Replace the 100A panel.') =>
    renderToStaticMarkup(
      <TitleScopeEditor title="Panel change" jobDescription={scope} busy={false} lockedReason={lockedReason} issuedNumber={null} onSave={noop} />,
    )
  it('collapsed: shows the title and the scope with a pencil, as one tappable line', () => {
    const html = render()
    expect(html).toContain('Panel change')
    expect(html).toContain('Replace the 100A panel.')
    expect(html).toContain('✎')
    expect(html).not.toContain('disabled=""')
  })
  it('no scope yet: says so and invites the tech to write one', () => {
    expect(render(null, null)).toContain('No scope of work yet')
  })
  it('a SIGNED quote greys the editor with the reason as its tooltip, not hidden', () => {
    const html = render(SIGNED)
    expect(html).toContain('disabled=""')
    expect(html).toContain(`title="${SIGNED}"`)
    expect(html).toContain('Panel change')
  })
})

describe('QuoteExits — Copy to a new quote / Delete this quote', () => {
  const render = (deleteReason: string | null) =>
    renderToStaticMarkup(<QuoteExits title="Panel change" lineCount={3} busy={false} deleteReason={deleteReason} onCopy={noop} onDelete={noop} />)
  it('nothing issued: both live', () => {
    const html = render(null)
    expect(html).toContain('Copy to a new quote')
    expect(html).toContain('Delete this quote')
    expect(html).not.toContain('disabled=""')
  })
  it('issued: Delete greyed, the reason is the tooltip AND printed under the buttons; Copy stays live', () => {
    const html = render(DELETE_REASON)
    expect((html.match(/disabled=""/g) ?? []).length).toBe(1)
    expect(html).toContain(`title="${DELETE_REASON}"`)
    expect(html.split(DELETE_REASON).length - 1).toBe(2)
    expect(html).toContain('Copy to a new quote')
  })
})

describe('IssuedEstimatePanel — after issue, and every time the tech comes back', () => {
  const render = (over: Partial<DraftLifecycle> = {}, unpriced: string[] = []) => {
    const l = lifecycle(over)
    return renderToStaticMarkup(
      <IssuedEstimatePanel issued={l.issued!} reviseReason={l.reviseReason} unpriced={unpriced} emailEstimate={async () => ({ to: 'x' })} emailFinancing={async () => ({ to: 'x' })} onEdit={() => {}} onBack={() => {}} />,
    )
  }
  it('unsigned: the headline, the customer-page link, the email button, and a live "Edit the estimate"', () => {
    const html = render()
    expect(html).toContain('Estimate 2026-1098 — issued, not signed yet')
    expect(html).toContain('href="https://rce.example.com/e/tok"')
    // The link is the customer's OWN-device door (recorded as signed from the emailed link), and
    // says so; it is not offered as the way to sign with the customer standing next to the tech.
    expect(html).toContain('for their own device')
    expect(html).not.toContain('review &amp; sign')
    expect(html).not.toContain('Hand the customer your phone')
    // No Show-the-customer button here (this render has no such screen), so the copy does not send
    // the tech to one; it only says what the page link records.
    expect(html).not.toContain('Show the customer')
    expect(html).toContain('recorded as')
    expect(html).toContain('Email the estimate to the customer')
    expect(html).toContain('Edit the estimate')
    expect(html).not.toContain('disabled=""')
    expect(html).toContain('Back to the job')
  })
  it('signed: "Edit the estimate" is greyed with the server\'s reason, printed too; the link reads "signed"', () => {
    const html = render({ issued: issued({ status: 'signed', signedAt: '2026-10-08T12:00:00.000Z' }), reviseReason: SIGNED })
    expect(html).toContain('disabled=""')
    expect(html).toContain(`title="${SIGNED}"`)
    expect(html.split(SIGNED).length - 1).toBe(2)
    expect(html).toContain('signed estimate')
  })
  it('lost: greyed with "reopen it first"', () => {
    expect(render({ issued: issued({ status: 'lost' }), reviseReason: LOST })).toContain(LOST)
  })
  it('repeats the $0-line warning from the issue that just happened', () => {
    expect(render({}, ['Mystery fan'])).toContain('Mystery fan')
  })
})

// ─── 2026-10-08 review fixes ──────────────────────────────────────────────────

describe('QuoteExits — "Copy to a new quote" on a change order or a diagnostic draft', () => {
  const COPY_REASON = 'This is a change order, so it can\'t be copied into a new quote.'
  const render = (copyReason: string | null) =>
    renderToStaticMarkup(<QuoteExits title="Change order — 2026-1098" lineCount={2} busy={false} deleteReason={null} copyReason={copyReason} onCopy={noop} onDelete={noop} />)
  it('greyed WITH the reason (tooltip and printed), never hidden; Delete stays live', () => {
    const html = render(COPY_REASON)
    expect(html).toContain('Copy to a new quote')
    expect((html.match(/disabled=""/g) ?? []).length).toBe(1)
    expect(html).toContain(`title="${COPY_REASON.replace(/'/g, '&#x27;')}"`)
    expect(html.split(COPY_REASON.replace(/'/g, '&#x27;')).length - 1).toBe(2)
  })
  it('an ordinary quote: live', () => {
    expect(render(null)).not.toContain('disabled=""')
  })
})

describe('emailBlockedReason + the issued panel on a signed or lost estimate', () => {
  const panel = (over: Partial<NonNullable<DraftLifecycle['issued']>>, extra: { onRaise?: boolean } = {}) =>
    renderToStaticMarkup(
      <IssuedEstimatePanel
        issued={issued(over)}
        reviseReason={over.signedAt ? SIGNED : over.status === 'lost' ? LOST : null}
        unpriced={[]}
        emailEstimate={async () => ({ to: 'x' })} emailFinancing={async () => ({ to: 'x' })}
        onEdit={() => {}}
        onBack={() => {}}
        onRaiseChangeOrder={extra.onRaise ? async () => {} : undefined}
      />,
    )
  it('unsigned: no reason, the email button is live', () => {
    expect(emailBlockedReason(issued())).toBeNull()
    expect(panel({})).not.toContain('disabled=""')
  })
  it('SIGNED: Email is greyed with why - the server refuses a signed send - and the signing prompts are gone', () => {
    const reason = emailBlockedReason(issued({ status: 'signed', signedAt: '2026-10-08T12:00:00.000Z' }))
    expect(reason).toContain('already signed')
    const html = panel({ status: 'signed', signedAt: '2026-10-08T12:00:00.000Z' })
    expect(html).toContain(reason!)
    expect(html).not.toContain('Hand the customer your phone')
    expect(html).not.toContain('Use the link above instead')
  })
  it('LOST: Email greyed with "reopen first"; no "hand the customer your phone ... sign" copy, no "review & sign" link', () => {
    const html = panel({ status: 'lost' })
    expect(html).toContain('marked lost, so it can&#x27;t be emailed')
    expect(html).not.toContain('Hand the customer your phone')
    expect(html).not.toContain('Next: the customer signs')
    expect(html).not.toContain('review &amp; sign')
  })
  it('ARCHIVED: Email greyed with "unarchive"', () => {
    expect(emailBlockedReason(issued({ archived: true }))).toContain('archived')
  })
  it('ruling 1: the SIGNED reason is Kyle\'s exact sentence, shared with the server, and "Raise a change order" sits right under the greyed button', () => {
    expect(FIELD_SIGNED_REVISE_REASON).toBe(SIGNED)
    const signed = { status: 'signed', signedAt: '2026-10-08T12:00:00.000Z' }
    const html = panel(signed, { onRaise: true })
    expect(html).toContain(`title="${SIGNED}"`)
    expect(html).toContain(`>${SIGNED}</p>`)
    expect(html.indexOf('Edit the estimate')).toBeLessThan(html.indexOf('Raise a change order'))
    expect(issueButtonState(lifecycle({ issued: issued(signed), hasUnsavedChanges: true, reviseReason: SIGNED })))
      .toEqual({ label: SAVE_CHANGES_LABEL, disabledReason: SIGNED })
  })
  it('SIGNED with a way to open the result: "Raise a change order" sits beside the greyed Edit button; without it, not drawn', () => {
    const signed = { status: 'signed', signedAt: '2026-10-08T12:00:00.000Z' }
    expect(panel(signed, { onRaise: true })).toContain('Raise a change order')
    expect(panel(signed)).not.toContain('Raise a change order')
    // Never on an estimate that is not signed - there the Edit button is live.
    expect(panel({}, { onRaise: true })).not.toContain('Raise a change order')
  })
  it('the back button names where it goes', () => {
    const html = renderToStaticMarkup(
      <IssuedEstimatePanel issued={issued()} reviseReason={null} unpriced={[]} emailEstimate={async () => ({ to: 'x' })} emailFinancing={async () => ({ to: 'x' })} onEdit={() => {}} onBack={() => {}} backLabel="Diagnostics" />,
    )
    expect(html).toContain('Back to the diagnostics')
  })
})

describe('IssuedEstimatePanel — "Show the customer" (Phase 3 unit B)', () => {
  const panel = (extra: { onShow?: boolean; reason?: string | null; signedAt?: string | null }) =>
    renderToStaticMarkup(
      <IssuedEstimatePanel
        issued={issued({ signedAt: extra.signedAt ?? null, status: extra.signedAt ? 'signed' : 'sent' })}
        reviseReason={null}
        unpriced={[]}
        emailEstimate={async () => ({ to: 'x' })} emailFinancing={async () => ({ to: 'x' })}
        onEdit={() => {}}
        onBack={() => {}}
        onShowCustomer={extra.onShow === false ? undefined : () => {}}
        showCustomerReason={extra.reason ?? null}
      />,
    )
  it('is on the issued panel, live, before the review-and-sign link', () => {
    const html = panel({})
    expect(html).toContain('Show the customer')
    expect(html.indexOf('>Show the customer<')).toBeLessThan(html.indexOf('for their own device'))
    expect(html).not.toContain('disabled=""')
  })
  it('greyed WITH the reason, on the page as well as in the tooltip', () => {
    const html = panel({ reason: 'Nothing is priced yet.' })
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Show the customer</)
    expect(html).toContain('title="Nothing is priced yet."')
    expect(html).toContain('<p class="text-[11px] text-amber-200">Nothing is priced yet.</p>')
  })
  it('is still there on a signed estimate (the customer can look; "Sign now" explains itself)', () => {
    expect(panel({ signedAt: '2026-10-08T12:00:00.000Z' })).toContain('Show the customer')
  })
  it('with the screen available, the copy names the in-person path: Show the customer, then Sign now', () => {
    const html = panel({})
    expect(html).toContain('Show the customer</span>, then')
    expect(html).toContain('Sign now</span> — that records a signature taken in person')
  })
  it('a caller with no such screen gets no button', () => {
    expect(panel({ onShow: false })).not.toContain('Show the customer')
  })
})

// ─── Phase 4 (2026-10-08): the financing link before signing, and the CRM's send options ──────────

describe('IssuedEstimatePanel — "Email the financing link" and the estimate email\'s options', () => {
  const render = (over: Partial<DraftLifecycle> = {}) => {
    const l = lifecycle(over)
    return renderToStaticMarkup(
      <IssuedEstimatePanel issued={l.issued!} reviseReason={l.reviseReason} unpriced={[]} emailEstimate={async () => ({ to: 'x' })} emailFinancing={async () => ({ to: 'x' })} onEdit={() => {}} onBack={() => {}} />,
    )
  }
  const SIGNED_ISSUED = { status: 'signed', signedAt: '2026-10-08T12:00:00.000Z' }
  const esc = (t: string) => t.replace(/'/g, '&#x27;')
  /** The opening tag of the button whose label is the financing one. */
  const financingTag = (html: string) => /<button[^>]*>(?=📧 Email the financing link)/.exec(html)?.[0] ?? ''

  it('sits beside "Email the estimate" BEFORE the customer signs, live', () => {
    const html = render()
    expect(html).toContain('📧 Email the financing link')
    expect(html.indexOf('Email the estimate to the customer')).toBeLessThan(html.indexOf('Email the financing link'))
    expect(financingTag(html)).not.toBe('')
    expect(financingTag(html)).not.toContain('disabled=""')
  })
  it('stays live on a SIGNED estimate (the server allows it; the payment panel sends it too)', () => {
    const html = render({ issued: issued(SIGNED_ISSUED), reviseReason: SIGNED })
    expect(financingTag(html)).not.toBe('')
    expect(financingTag(html)).not.toContain('disabled=""')
  })
  it('lost: greyed WITH the reason (tooltip and printed), never hidden', () => {
    const reason = financingBlockedReason(issued({ status: 'lost' }))!
    expect(reason).toMatch(/lost/)
    const html = render({ issued: issued({ status: 'lost' }), reviseReason: LOST })
    expect(financingTag(html)).toContain('disabled=""')
    expect(financingTag(html)).toContain(`title="${esc(reason)}"`)
    expect(html).toContain(`>${esc(reason)}</p>`)
  })
  it('a live estimate has no financing refusal on the phone; the server decides void and superseded', () => {
    expect(financingBlockedReason(issued())).toBeNull()
    expect(financingBlockedReason(issued(SIGNED_ISSUED))).toBeNull()
    expect(financingBlockedReason(issued({ archived: true }))).toBeNull()
  })

  it('carries the CRM send panel\'s options with its words and its defaults', () => {
    const html = render()
    expect(html).toContain('placeholder="Send to a different address (optional)"')
    expect(html).toContain('placeholder="Optional note to include in the email"')
    // [ticked?, label] in the order the CRM lists them
    const boxes = [...html.matchAll(/<input type="checkbox"([^>]*)\/>([^<]+)</g)].map((m) => [m[1].includes('checked'), m[2].trim()] as const)
    expect(boxes).toEqual([
      [false, 'Attach Electrical Health Record report (latest assessment at this address)'],
      [false, 'Attach Generator Sizing data sheet'],
      [true, 'Include the Synchrony financing link'],
    ])
  })
  it('the options are not offered when the email itself is refused (signed / lost / archived) - the reason is', () => {
    const html = render({ issued: issued(SIGNED_ISSUED), reviseReason: SIGNED })
    expect(html).not.toContain('Send to a different address (optional)')
    expect(html).toContain(emailBlockedReason(issued(SIGNED_ISSUED))!)
  })
})
