/**
 * The field app's Messages (work order agent-team, U5): the words and shapes the screens are built from.
 * Static renders only (renderToStaticMarkup): this suite has no DOM harness, so what is pinned is what a
 * component prints for a given input - the button labels with their counts, the list rows, a message with
 * and without Edit / Delete, the "Not sent, no signal. Tap to retry." row, and that no token or customer
 * detail appears.
 */

import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  EDIT_NEEDS_WORDS, EditReason, MessageBubble, MessageThreadScreen, MessagesScreen, PHOTO_BUTTON, PHOTO_CLOSED_REASON, ThreadRows, UNSENT_TEXT,
  UnsentRow, heldPhotosToRestore, jobMessagesLabel, messagesButtonLabel, needsApprovalLabel, photoClosedReason, takeBackHeldPhotos,
} from './MessagesScreen'
import type { TechMessage, TechThreadRow } from '../../../../shared/hub/views'

const row = (over: Partial<TechThreadRow> = {}): TechThreadRow => ({
  key: 'team', kind: 'team', threadId: 't-team', title: 'Eric ↔ AI team', visitId: null, unread: 0, lastLine: null, lastMessageAt: null, ...over,
})
const message = (over: Partial<TechMessage> = {}): TechMessage => ({
  id: 'm1', authorType: 'tech', authorLabel: 'Eric', body: 'Panel is open', deleted: false, editedAt: null,
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
  it("an approver's chip at the top of Messages counts what waits", () => {
    expect(needsApprovalLabel(3)).toBe('Needs approval (3)')
    expect(needsApprovalLabel(0)).toBe('Needs approval (0)')
  })
})

describe('the list', () => {
  it('shows your own Team thread, then one row per job, with the unread and the last line', () => {
    const html = renderToStaticMarkup(
      <ThreadRows
        threads={[
          row({ unread: 1, lastLine: { authorLabel: 'RCE Admin (AI)', text: 'Bring the 200 amp base', at: '2026-11-22T15:00:00.000Z' } }),
          row({ key: 'job:v1', kind: 'job', threadId: null, title: 'Jane Homeowner — 12 Main St', visitId: 'v1' }),
        ]}
      />,
    )
    expect(html).toContain('Team — you and the AI team')
    expect(html).toContain('1 new')
    expect(html).toContain('RCE Admin (AI): Bring the 200 amp base')
    expect(html).toContain('Jane Homeowner — 12 Main St')
    expect(html).toContain('Nothing said yet.')
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
