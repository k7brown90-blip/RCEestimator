/**
 * The field app's approval card (work order agent-team, U10): the words and the greying, rendered statically (this suite
 * has no DOM harness), pinned against the SAME rules the CRM's card reads (shared/hub/approvalRules.ts) - so a button the
 * CRM greys with a reason is greyed here with that very sentence, and the labels are the ones Kyle says out loud:
 * "Approve and send", "Edit" -> "Send my version", "Reject" -> "Why?" -> "Reject draft".
 */
import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ApprovalCard } from './ApprovalCard'
import { REJECT_FIRST_HINT, SMS_HELD_OUTCOME, cardLocks, isActionable, isOpenCard } from '../../../../shared/hub/approvalRules'
import { CRM_POWERS } from '../../../../shared/crmPowers'
import type { ApprovalCardView } from '../../../../shared/hub/views'

const POWER = CRM_POWERS.approve_drafts.reason

const card = (over: Partial<ApprovalCardView> = {}): ApprovalCardView => ({
  id: 'm1', threadId: 't1', threadTitle: 'Jane Homeowner', threadKind: 'customer', customerId: 'c1',
  kind: 'customer_message', kindLabel: 'Message to a customer', status: 'pending_approval', channel: 'email',
  draftedBy: 'RCE Admin (AI)', draftedByAi: true, createdAt: '2026-11-22T15:00:00.000Z',
  headerLine: 'Email · Transactional — Reply in a conversation', recipient: 'Jane', recipientAddress: 'jane@example.com',
  subject: 'Tuesday', body: 'We can be there Tuesday.', cc: ['pat@example.com'], sendsAs: null, recent: [],
  effectLines: ['Emails Jane at jane@example.com from Red Cedar Electric.'],
  chip: { tone: 'customer', text: 'This will email the customer' },
  approve: { label: 'Approve and send', confirm: 'Send this email to Jane (jane@example.com)? It goes to the customer.', blockedReason: null, editBlockedReason: null },
  editable: { subject: true, to: true, cc: true },
  outcome: { text: null, error: null, decidedBy: null, decidedAt: null, rejectedReason: null, sentAt: null, emailDelivery: null },
  ...over,
})

const render = (c: ApprovalCardView, canApprove = true, reason: string | null = null) =>
  renderToStaticMarkup(<ApprovalCard card={c} canApprove={canApprove} approveReason={reason} />)

describe('a draft waiting, for a person who may approve', () => {
  it('says who drafted it, what it is, who it goes to, and what Approve will do', () => {
    const html = render(card())
    expect(html).toContain('Draft by RCE Admin (AI) · Email · Transactional — Reply in a conversation · to Jane')
    expect(html).toContain('This will email the customer')
    expect(html).toContain('Tuesday')
    expect(html).toContain('We can be there Tuesday.')
    expect(html).toContain('To jane@example.com · cc pat@example.com')
    expect(html).toContain('When you approve')
    expect(html).toContain('Emails Jane at jane@example.com from Red Cedar Electric.')
  })

  it('has the three buttons, named as Kyle says them, all live', () => {
    const html = render(card())
    expect(html).toContain('>Approve and send<')
    expect(html).toContain('>Edit<')
    expect(html).toContain('>Reject<')
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Approve and send/)
    expect(html).not.toContain('data-testid="approval-lock"')
  })

  it('a text shows the exact words it will go out as', () => {
    const html = render(card({ channel: 'sms', subject: null, sendsAs: 'Red Cedar Electric: Tuesday works. Reply STOP to opt out.', recipientAddress: null }))
    expect(html).toContain('Sends as:')
    expect(html).toContain('Tuesday works. Reply STOP to opt out.')
  })
})

describe('greyed, never hidden, with the reason printed on the card', () => {
  it("prints the server's own sentence when Approve is blocked, and Edit stays live when only the words are at fault", () => {
    const blocked = 'There is no email address on file for this customer. Edit the draft and type one.'
    const html = render(card({ approve: { label: 'Approve and send', confirm: 'x', blockedReason: blocked, editBlockedReason: null }, recipientAddress: null }))
    expect(html).toContain(blocked)
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="There is no email[^"]*"[^>]*>Approve and send/)
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Edit</)
  })

  it('a person without the power sees every button greyed with the power\'s sentence, and the buttons are still there', () => {
    const html = render(card(), false, POWER)
    expect(html).toContain(POWER)
    for (const label of ['Approve and send', 'Edit', 'Reject']) expect(html).toMatch(new RegExp(`<button[^>]*disabled=""[^>]*>${label}<`))
  })

  it('the rules are the CRM\'s: the same locks, labels and exits from the one shared file', () => {
    const waiting = card()
    expect(cardLocks(waiting, true, null)).toEqual({ lock: null, editLock: null, rejectLock: null, approveLabel: 'Approve and send' })
    expect(cardLocks(waiting, false, POWER)).toEqual({ lock: POWER, editLock: POWER, rejectLock: POWER, approveLabel: 'Approve and send' })
    expect(cardLocks(card({ status: 'failed' }), true, null).approveLabel).toBe('Try sending again')
    expect(cardLocks(card({ status: 'approved' }), true, null).approveLabel).toBe('Send now')
    expect(isActionable(card())).toBe(true)
    expect(isActionable(card({ status: 'sent' }))).toBe(false)
    expect(isActionable(card({ status: 'approved', outcome: { ...card().outcome, text: SMS_HELD_OUTCOME } }))).toBe(true)
    expect(isActionable(card({ status: 'approved' }))).toBe(false)
    expect(isOpenCard('blocked')).toBe(true)
    expect(isOpenCard('sent')).toBe(false)
    expect(REJECT_FIRST_HINT).toBe('Type a reason first')
  })
})

describe('exits and the record of what happened', () => {
  it('a failed send offers "Try sending again" and Reject, and a held text offers "Send now"', () => {
    const failed = render(card({ status: 'failed', outcome: { ...card().outcome, text: 'Could not be sent: Mail provider down' } }))
    expect(failed).toContain('>Try sending again<')
    expect(failed).toContain('>Reject<')
    expect(failed).not.toContain('>Edit<')
    const held = render(card({ status: 'approved', channel: 'sms', outcome: { ...card().outcome, text: SMS_HELD_OUTCOME } }))
    expect(held).toContain('>Send now<')
  })

  it('a sent card is the record: who sent it, no buttons', () => {
    const html = render(card({ status: 'sent', outcome: { ...card().outcome, text: 'Sent by Kyle' } }))
    expect(html).toContain('Sent by Kyle')
    expect(html).not.toContain('>Approve and send<')
    expect(html).not.toContain('>Reject<')
  })

  it('a rejected card keeps the reason', () => {
    const html = render(card({ status: 'rejected', outcome: { ...card().outcome, text: 'Rejected: wrong customer' } }))
    expect(html).toContain('Rejected: wrong customer')
  })
})

describe('what a phone never shows', () => {
  it('no phone number, key or token is in the card', () => {
    const html = render(card({ channel: 'sms', sendsAs: 'Tuesday works.', recipientAddress: null }))
    expect(html).not.toMatch(/\d{3}[-. )]*\d{3}[-. ]*\d{4}/)
    expect(html.toLowerCase()).not.toContain('token')
  })
})
