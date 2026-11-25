/**
 * The field app's Messages (work order agent-team, U5): the words and shapes the screens are built from.
 * Static renders only (renderToStaticMarkup): this suite has no DOM harness, so what is pinned is what a
 * component prints for a given input - the button labels with their counts, the list rows, a message with
 * and without Edit / Delete, the "Not sent, no signal. Tap to retry." row, and that no token or customer
 * detail appears.
 */

import { describe, expect, it } from 'vitest'
import * as messagesScreen from './MessagesScreen'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  EDIT_NEEDS_WORDS, EditReason, GROUP_CLOSED_NOTE, MessageBubble, MessageThreadScreen, MessagesScreen, PHOTO_BUTTON, PHOTO_CLOSED_REASON, ThreadRows, UNSENT_TEXT,
  UnsentRow, heldPhotosToRestore, jobMessagesLabel, messagesButtonLabel, approvalChipLabel, photoClosedReason, takeBackHeldPhotos,
} from './MessagesScreen'
import { AVATAR_ROLES, agentAvatar } from '../../../../shared/hub/agentAvatar'
import { WAITING_FOR_APPROVAL, waitingForApprovalLabel } from '../../../../shared/hub/approvalRules'
import { readMessagesLaunch } from '../../lib/messagesLaunch'
import type { TechMessage, TechThreadRow } from '../../../../shared/hub/views'

const row = (over: Partial<TechThreadRow> = {}): TechThreadRow => ({
  key: 'team', kind: 'team', threadId: 't-team', title: 'Eric ↔ AI team', visitId: null, unread: 0, lastLine: null, lastMessageAt: null, ...over,
})
const message = (over: Partial<TechMessage> = {}): TechMessage => ({
  id: 'm1', authorType: 'tech', agentRole: null, authorLabel: 'Eric', body: 'Panel is open', deleted: false, editedAt: null,
  createdAt: '2026-11-22T15:00:00.000Z', at: '2026-11-22T15:00:00.000Z', mine: true, canEdit: true, canDelete: true, attachments: [], photoIds: [], ...over,
})

describe('the buttons', () => {
  it("home: 'Messages (n new)', and plain 'Messages' when nothing is new", () => {
    expect(messagesButtonLabel(3)).toBe('💬 Messages (3 new)')
    expect(messagesButtonLabel(0)).toBe('💬 Messages')
  })
  it("job site: 'Job messages (n)', and plain 'Job messages' when nothing is new", () => {
    expect(jobMessagesLabel(2)).toBe('💬 Job messages (2)')
    expect(jobMessagesLabel(0)).toBe('💬 Job messages')
  })
  it('the photo button says what it does', () => {
    expect(PHOTO_BUTTON).toBe('📷 Add photo')
  })
  // Kyle 2026-11-23 item 6: "waiting for approval", the CRM's words (shared/hub/approvalRules.ts), no longer "Needs approval".
  it("an approver's chip at the top of Messages counts what waits, in the CRM's own words", () => {
    expect(approvalChipLabel(3)).toBe('Waiting for approval (3)')
    expect(approvalChipLabel(0)).toBe('Waiting for approval (0)')
    expect(approvalChipLabel(3)).toBe(waitingForApprovalLabel(3))
  })
  it("an approver's home button says how many drafts wait; everyone else's is unchanged (W2-D)", () => {
    expect(messagesButtonLabel(2, 1)).toBe('💬 Messages (2 new) · 1 waiting for approval')
    expect(messagesButtonLabel(0, 3)).toBe('💬 Messages · 3 waiting for approval')
    expect(messagesButtonLabel(2, 0)).toBe('💬 Messages (2 new)')
    expect(messagesButtonLabel(2)).toBe('💬 Messages (2 new)')
  })
})

describe('the list', () => {
  it('shows your own Team thread, then one row per job, with the unread and the last line', () => {
    const html = renderToStaticMarkup(
      <ThreadRows
        threads={[
          row({ unread: 1, lastLine: { authorType: 'ai_agent', agentRole: 'admin', authorLabel: 'RCE Admin (AI)', text: 'Bring the 200 amp base', at: '2026-11-22T15:00:00.000Z' } }),
          row({ key: 'job:v1', kind: 'job', threadId: null, title: 'Jane Homeowner — 12 Main St', visitId: 'v1' }),
        ]}
      />,
    )
    expect(html).toContain('Team — you and the AI team')
    expect(html).toContain('1 new')
    // W2-D: the avatar and the "AI" chip say it is an AI, so the name drops its "(AI)" (said once, not twice).
    expect(html).toContain('RCE Admin: Bring the 200 amp base')
    expect(html).not.toContain('(AI):')
    expect(html).toContain('aria-label="Admin (AI)"')
    expect(html).toContain('data-testid="ai-chip"')
    expect(html).toContain('Jane Homeowner — 12 Main St')
    expect(html).toContain('Nothing said yet.')
  })

  it("shows a group chat the office put you in by its name with a 'Group' tag, between Team and the jobs (C7)", () => {
    const html = renderToStaticMarkup(
      <ThreadRows
        threads={[
          row(),
          row({ key: 'group:g1', kind: 'group', threadId: 'g1', title: 'Install crew', unread: 2, lastLine: { authorType: 'tech', agentRole: null, authorLabel: 'Sam', text: 'Truck is loaded', at: '2026-11-22T15:00:00.000Z' } }),
          row({ key: 'job:v1', kind: 'job', threadId: null, title: 'Jane Homeowner — 12 Main St', visitId: 'v1' }),
        ]}
      />,
    )
    expect(html).toContain('Install crew')
    expect(html).toContain('>Group<')
    expect(html).toContain('2 new')
    expect(html).toContain('Sam: Truck is loaded')
    expect(html).not.toContain('data-agent-avatar')
    expect(html).not.toContain('data-testid="ai-chip"')
    expect(html.indexOf('Team — you and the AI team')).toBeLessThan(html.indexOf('Install crew'))
    expect(html.indexOf('Install crew')).toBeLessThan(html.indexOf('Jane Homeowner'))
  })

  it('shows a Training row only when it is given one', () => {
    expect(renderToStaticMarkup(<ThreadRows threads={[row()]} />)).not.toContain('Training')
    expect(renderToStaticMarkup(<ThreadRows threads={[row({ key: 'training', kind: 'training', title: 'Training' })]} />)).toContain('Training')
  })
})

describe('a message', () => {
  it('your own carries Edit and Delete; someone else\'s carries neither', () => {
    const mine = renderToStaticMarkup(<MessageBubble message={message()} visitId="v1" />)
    expect(mine).toContain('>Edit<')
    expect(mine).toContain('>Delete<')
    const theirs = renderToStaticMarkup(<MessageBubble message={message({ mine: false, canEdit: false, canDelete: false, authorLabel: 'Kyle' })} visitId="v1" />)
    expect(theirs).not.toContain('>Edit<')
    expect(theirs).not.toContain('>Delete<')
    expect(theirs).toContain('Kyle')
  })

  it('a deleted one leaves "Deleted" and no text or buttons', () => {
    const html = renderToStaticMarkup(<MessageBubble message={message({ deleted: true, body: null })} visitId="v1" />)
    expect(html).toContain('Deleted')
    expect(html).not.toContain('Panel is open')
    expect(html).not.toContain('>Edit<')
  })

  it('marks an edited message, and holds a photo-only message without an empty line of text', () => {
    const html = renderToStaticMarkup(
      <MessageBubble message={message({ body: '', editedAt: '2026-11-22T15:05:00.000Z', attachments: [{ id: 'a1', mimeType: 'image/jpeg' }] })} visitId={null} />,
    )
    expect(html).toContain('edited')
    expect(html).toContain('data-testid="message-photos"')
    expect(html).not.toContain('whitespace-pre-wrap')
  })
})

// ── W2-D: who wrote it ─────────────────────────────────────────────────────────────────────────
describe("an agent's message (W2-D)", () => {
  const agentMsg = (role: string | null, type = 'ai_agent', label = 'Sage (AI)') =>
    message({ authorType: type, agentRole: role, authorLabel: label, mine: false, canEdit: false, canDelete: false })

  it("draws the agent's round avatar, its initials on its role colour, and an AI chip, for every one of the nine roles", () => {
    for (const role of AVATAR_ROLES) {
      const a = agentAvatar(role)
      const html = renderToStaticMarkup(<MessageBubble message={agentMsg(role, role === 'claude_code' ? 'claude' : 'ai_agent')} visitId={null} />)
      expect(html).toContain(`data-agent-avatar="${role}"`)
      expect(html).toContain(`aria-label="${a.ariaLabel}"`)
      expect(html).toContain(`>${a.initials}<`)
      expect(html).toContain(`background:${a.background}`)
      expect(html).toContain('data-testid="ai-chip"')
    }
  })

  it('says "AI" once: the name drops the "(AI)" the server adds, the chip and the avatar carry it', () => {
    const html = renderToStaticMarkup(<MessageBubble message={agentMsg('inventory', 'ai_agent', 'Inventory Bot (AI)')} visitId={null} />)
    expect(html).toContain('Inventory Bot')
    expect(html).not.toContain('Inventory Bot (AI)')
    expect(html).toContain('aria-label="Inventory (AI)"')
  })

  it('an AI post whose key is gone (role unknown) still shows the neutral AI avatar and chip', () => {
    const html = renderToStaticMarkup(<MessageBubble message={agentMsg(null)} visitId={null} />)
    expect(html).toContain('data-agent-avatar="other"')
    expect(html).toContain('aria-label="AI agent (AI)"')
    expect(html).toContain('data-testid="ai-chip"')
  })

  it("a person's message has no avatar and no chip, and keeps its own name as it was", () => {
    for (const m of [message(), message({ authorType: 'office', authorLabel: 'Kyle', mine: false, canEdit: false, canDelete: false })]) {
      const html = renderToStaticMarkup(<MessageBubble message={m} visitId={null} />)
      expect(html).not.toContain('data-agent-avatar')
      expect(html).not.toContain('data-testid="ai-chip"')
      expect(html).toContain(m.authorLabel)
    }
  })

  it("the thread list's last line shows the small avatar and chip for an agent, nothing extra for a person", () => {
    const agent = renderToStaticMarkup(<ThreadRows threads={[row({ lastLine: { authorType: 'claude', agentRole: 'claude_code', authorLabel: 'Coder (AI)', text: 'PR is up', at: '2026-11-22T15:00:00.000Z' } })]} />)
    expect(agent).toContain('data-agent-avatar="claude_code"')
    expect(agent).toContain('data-testid="ai-chip"')
    expect(agent).toContain('Coder: PR is up')
    const person = renderToStaticMarkup(<ThreadRows threads={[row({ lastLine: { authorType: 'office', agentRole: null, authorLabel: 'Kyle', text: 'Thanks', at: '2026-11-22T15:00:00.000Z' } })]} />)
    expect(person).not.toContain('data-agent-avatar')
    expect(person).toContain('Kyle: Thanks')
  })
})

describe('Waiting for approval (W2-D)', () => {
  it('opening Messages from an approval push lands on the approval list, headed "Waiting for approval"', () => {
    const html = renderToStaticMarkup(<MessagesScreen onBack={() => undefined} openApprovals />)
    expect(html).toContain(`>${WAITING_FOR_APPROVAL}<`)
    expect(html).toContain('← Messages')
    expect(html).not.toContain('Needs approval')
  })
  it('without the push, Messages opens on the list of threads, not the approval list', () => {
    const html = renderToStaticMarkup(<MessagesScreen onBack={() => undefined} />)
    expect(html).toContain('← Today')
  })
  it("a push tap's address is read once: ?approvals=1 opens the list, ?thread=<id> opens that thread, and both words leave the address", () => {
    expect(readMessagesLaunch('?approvals=1')).toEqual({ thread: null, approvals: true, rest: '' })
    expect(readMessagesLaunch('?thread=abc&x=1')).toEqual({ thread: 'abc', approvals: false, rest: 'x=1' })
    expect(readMessagesLaunch('?approvals=1&y=2')).toEqual({ thread: null, approvals: true, rest: 'y=2' })
    expect(readMessagesLaunch('?approvals=yes')).toMatchObject({ approvals: false })
    expect(readMessagesLaunch('')).toEqual({ thread: null, approvals: false, rest: '' })
  })
})

describe('no signal', () => {
  it("a message that did not go stays on screen as 'Not sent, no signal. Tap to retry.'", () => {
    const html = renderToStaticMarkup(<UnsentRow unsent={{ localId: 'u1', body: 'Need the 200 amp base', photos: [], clientMessageId: 'c-0001-aaaa' }} onRetry={() => undefined} onDiscard={() => undefined} />)
    expect(html).toContain('Need the 200 amp base')
    expect(html).toContain(UNSENT_TEXT)
    expect(UNSENT_TEXT).toBe('Not sent, no signal. Tap to retry.')
    expect(html).toContain('Discard this message')
  })

  it('says how many pictures are waiting with it', () => {
    const photo = { key: 'p', preview: 'blob:x', blob: new Blob(['x']) }
    const html = renderToStaticMarkup(<UnsentRow unsent={{ localId: 'u1', body: '', photos: [photo, photo], clientMessageId: 'c-0001-aaaa' }} />)
    expect(html).toContain('2 photos')
  })
})

// A retry never posts the same message twice: the office answers a repeat of a clientMessageId with the message it already
// made (tests/hubClientMessageId.test.ts), so the old "did the first try get through?" word-matching guess is gone.
// What this screen owes is to send the SAME id on every try (crmSync.hubMessages.test.ts pins the request).

describe('a photo that was added and never sent is never stranded', () => {
  it('offers back the held photos the screen is not already showing', () => {
    const held = [{ id: 'a1', mimeType: 'image/jpeg' }, { id: 'a2', mimeType: 'image/jpeg' }]
    expect(heldPhotosToRestore(held, new Set())).toEqual(held)
    expect(heldPhotosToRestore(held, new Set(['a1']))).toEqual([held[1]])
    expect(heldPhotosToRestore(held, new Set(['a1', 'a2']))).toEqual([])
  })

  it("Discard takes back each held picture, skips a job's (it is the job's), and carries on when one cannot be reached", async () => {
    const photos = [
      { key: 'job-photo', preview: 'blob:j', blob: new Blob(['j']) },
      { key: 'a1', preview: 'blob:a', blob: new Blob(['a']), attachmentId: 'a1' },
      { key: 'a2', preview: 'blob:b', blob: new Blob(['b']), attachmentId: 'a2' },
    ]
    const removed: string[] = []
    await takeBackHeldPhotos(photos, async (id) => { if (id === 'a1') throw new Error('no signal'); removed.push(id) })
    expect(removed).toEqual(['a2'])
  })
})

describe('greyed with the real reason, never silently', () => {
  it("Add photo is greyed on a closed Team or Training thread, with the reason; not on a job's, which is filed on the job", () => {
    expect(photoClosedReason('closed', 'team')).toBe(PHOTO_CLOSED_REASON)
    expect(photoClosedReason('closed', 'training')).toBe(PHOTO_CLOSED_REASON)
    expect(photoClosedReason('closed', 'job')).toBeNull()
    expect(photoClosedReason('open', 'team')).toBeNull()
    expect(photoClosedReason(undefined, undefined)).toBeNull()
    // The field app has no Reopen control: the sentence must not send the technician to one.
    expect(PHOTO_CLOSED_REASON).toContain('Send a message to open it again')
    expect(PHOTO_CLOSED_REASON).not.toMatch(/reopen/i)
  })

  it('an empty edit box (a photo-only message) says why Save changes is greyed, and says nothing once there are words', () => {
    expect(EDIT_NEEDS_WORDS).toContain('Type some words to save.')
    expect(renderToStaticMarkup(<EditReason draft="" />)).toContain('Type some words to save.')
    expect(renderToStaticMarkup(<EditReason draft="   " />)).toContain('use Delete')
    expect(renderToStaticMarkup(<EditReason draft="Panel is open" />)).toBe('')
  })
})

// Kyle, 2026-11-24: "I need be able to upload photos to all chats in the field app and CRM messages that we just built including
// group chats". This block used to pin the opposite (a group "holds words only", PHOTO_GROUP_REASON); it is changed on purpose, not deleted.
describe('a group chat takes photos like Team, and a message never reopens it (C7, photos 2026-11-24)', () => {
  it('has its closed-group words, and the old "words only" reason is gone', () => {
    expect(GROUP_CLOSED_NOTE).toBe('The office closed this group. You can read it; sending is off until the office reopens it.')
    expect('PHOTO_GROUP_REASON' in messagesScreen).toBe(false)
  })
  it('an open group has no photo reason: 📷 Add photo is live, exactly as on Team', () => {
    expect(photoClosedReason('open', 'group')).toBeNull()
    expect(photoClosedReason('open', 'team')).toBeNull()
  })
  it('a closed group says the group is closed (only the office Reopens it), never "Send a message to open it again"', () => {
    const reason = photoClosedReason('closed', 'group')
    expect(reason).toBe(GROUP_CLOSED_NOTE)
    expect(reason).not.toBe(PHOTO_CLOSED_REASON)
    expect(reason).not.toContain('Send a message to open it again')
  })
  it("a group member's own photo message shows its photo and carries Delete (which takes the photo with it)", () => {
    const html = renderToStaticMarkup(
      <MessageBubble message={message({ body: 'Look at this', attachments: [{ id: 'a1', mimeType: 'image/jpeg' }] })} visitId={null} />,
    )
    expect(html).toContain('data-testid="message-photos"')
    expect(html).toContain('>Delete<')
  })
})

describe('the screens before anything has loaded', () => {
  it('the Messages list names itself, offers notifications, and says it is loading', () => {
    const html = renderToStaticMarkup(<MessagesScreen onBack={() => undefined} />)
    expect(html).toContain('← Today')
    expect(html).toContain('Messages')
    expect(html).toContain('Reconnecting…')
    expect(html).toContain('Loading…')
    expect(html).toContain('Turn on notifications on this device')
  })

  it('a thread has the box, Send and the photo button, greyed until it has loaded', () => {
    const html = renderToStaticMarkup(<MessageThreadScreen visitId="v1" title="Job messages" onBack={() => undefined} />)
    expect(html).toContain('aria-label="Message"')
    expect(html).toContain('>Send<')
    expect(html).toContain('📷 Add photo')
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Send<\/button>/)
    expect(html).not.toContain('accessToken')
  })

  it('shows no Dev thread and no ticket choice anywhere (team answer 11b)', () => {
    const html = renderToStaticMarkup(<MessagesScreen onBack={() => undefined} />)
    expect(html.toLowerCase()).not.toContain('dev thread')
    expect(html.toLowerCase()).not.toContain('ticket')
  })
})
