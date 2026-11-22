/**
 * Messages in the field app (work order agent-team, U5, U6, U7): the same hub as the office's Messages page,
 * read from the job site.
 *
 *   Home            "💬 Messages (3 new)" under the day's list, beside "My accounts", "Purchases", "My truck".
 *   Job site        "💬 Job messages (n)": opens THAT job's crew thread straight away.
 *   Messages        the list: your own "Team" thread (you and the AI team), your "Training" thread if you have one,
 *                   and one row per job you are on. "Turn on notifications on this device" is at the top of it.
 *   A thread        the messages, a box and "Send". "📷 Add photo" puts a picture on the message: on a job it is
 *                   filed on the JOB's own photos; on Team it is held on the message. Your own messages carry
 *                   "Edit" and "Delete" (Delete leaves "Deleted" where it was; the office keeps the words).
 *   No signal       the message stays on screen as "Not sent, no signal. Tap to retry."
 *
 * Click path from home: Messages -> the thread (2 taps). From a job: Job site -> Job messages (1 tap).
 * You see the crew's messages only; a text or email to the customer never shows here. Names only: your own
 * name, the office's, "<name> (AI)".
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  compressReceiptImage,
  deleteHubMessage,
  editHubMessage,
  fetchHubAttachment,
  fetchHubThread,
  fetchHubThreads,
  fetchVisitPhotoThumb,
  isNetworkFailure,
  markHubThreadRead,
  openJobThread,
  removeHubAttachment,
  sendHubMessage,
  uploadHubAttachment,
  uploadJobPhoto,
} from '../../lib/crmSync'
import { liveLabel, useHubLive } from '../../lib/hubLive'
import { NotificationsButton } from '../components/NotificationsButton'
import { PhotoPicker } from '../components/PurchaseOrderPanel'
import type { AttachmentRef, TechMessage, TechThreadDetail, TechThreadRow } from '../../../../shared/hub/views'

// ── words the screens share (and the tests pin) ────────────────────────────────────────────────

/** The home screen's button. */
export const messagesButtonLabel = (unread: number): string => `💬 Messages${unread > 0 ? ` (${unread} new)` : ''}`
/** The Job site's button. */
export const jobMessagesLabel = (unread: number): string => `💬 Job messages${unread > 0 ? ` (${unread})` : ''}`
export const UNSENT_TEXT = 'Not sent, no signal. Tap to retry.'
export const PHOTO_BUTTON = '📷 Add photo'
/** Why "Save changes" is greyed on an empty box (a photo-only message edited down to nothing). */
export const EDIT_NEEDS_WORDS = "Type some words to save. A message can't be edited down to nothing. To take the photo back, use Delete."
/** Why "📷 Add photo" is greyed on a Team or Training thread the office closed (a job's photo is the job's and is not held here). */
export const PHOTO_CLOSED_REASON = 'The office closed this thread. Send a message to open it again, then add a photo.'

const whenText = (iso: string): string =>
  new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })

// ── the list ────────────────────────────────────────────────────────────────────────────────────

export function ThreadRows({ threads, onOpen }: { threads: TechThreadRow[]; onOpen?: (row: TechThreadRow) => void }) {
  return (
    <ul className="space-y-2">
      {threads.map((t) => (
        <li key={t.key}>
          <button
            type="button"
            onClick={() => onOpen?.(t)}
            data-thread-key={t.key}
            className="flex w-full items-start gap-3 rounded-lg border border-sky-900 bg-slate-800 p-3 text-left text-white"
          >
            <span aria-hidden="true" className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${t.unread > 0 ? 'bg-sky-400' : 'bg-transparent'}`} />
            <span className="min-w-0 flex-1">
              <span className="flex items-center justify-between gap-2">
                <span className={`truncate text-sm ${t.unread > 0 ? 'font-bold' : 'font-medium'}`}>
                  {t.kind === 'team' ? 'Team — you and the AI team' : t.kind === 'training' ? 'Training' : t.title}
                </span>
                {t.unread > 0 && <span className="shrink-0 text-[11px] font-semibold text-sky-300">{t.unread} new</span>}
              </span>
              {t.lastLine ? (
                <span className="mt-0.5 block truncate text-xs text-slate-400">{t.lastLine.authorLabel}: {t.lastLine.text}</span>
              ) : (
                <span className="mt-0.5 block text-xs text-slate-500">Nothing said yet.</span>
              )}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}

export function MessagesScreen({ onBack, openThreadId }: { onBack: () => void; openThreadId?: string | null }) {
  const live = useHubLive()
  const [threads, setThreads] = useState<TechThreadRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<{ threadId?: string; visitId?: string; title: string } | null>(
    openThreadId ? { threadId: openThreadId, title: 'Messages' } : null,
  )

  useEffect(() => {
    let alive = true
    fetchHubThreads()
      .then((r) => { if (alive) { setThreads(r.threads); setError(null) } })
      .catch((err) => { if (alive) setError(isNetworkFailure(err) ? 'No signal — showing nothing new until you are back.' : err instanceof Error ? err.message : String(err)) })
    return () => { alive = false }
  }, [live.tick, selected])

  if (selected) {
    return (
      <MessageThreadScreen
        threadId={selected.threadId}
        visitId={selected.visitId}
        title={selected.title}
        onBack={() => setSelected(null)}
      />
    )
  }

  return (
    <div className="mx-auto max-w-xl space-y-4 p-6 pb-16">
      <button type="button" onClick={onBack} className="text-sm text-sky-300">← Today</button>
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-white">Messages</h1>
        <p className="text-xs text-slate-400" data-testid="live-status">{liveLabel(live.status)}</p>
      </header>
      <NotificationsButton />
      {error && <p className="rounded-lg bg-slate-800 p-2 text-xs text-amber-200">{error}</p>}
      {threads === null && !error && <p className="text-sm text-slate-400">Loading…</p>}
      {threads && (
        <ThreadRows
          threads={threads}
          onOpen={(t) => setSelected({ threadId: t.threadId ?? undefined, visitId: t.threadId ? undefined : t.visitId ?? undefined, title: t.kind === 'team' ? 'Team' : t.title })}
        />
      )}
    </div>
  )
}

// ── a thread ────────────────────────────────────────────────────────────────────────────────────

/** A picture picked and not yet sent. A Team photo is already held (`attachmentId`); a job's waits for Send. */
interface Staged {
  key: string
  preview: string
  blob: Blob
  attachmentId?: string
}

/** A message that did not reach the office: kept on screen until it does. */
export interface Unsent {
  localId: string
  body: string
  photos: Staged[]
  /** When the first try began (this phone's clock): a message of mine made after it means the first try DID reach the office. */
  startedAt: string
  error?: string
}

/** The line under an edit box that is empty (a photo-only message): why "Save changes" is greyed. Nothing when there are words. */
export function EditReason({ draft }: { draft: string }) {
  if (draft.trim()) return null
  return <p className="text-xs text-amber-200" data-testid="edit-needs-words">{EDIT_NEEDS_WORDS}</p>
}

/** Why "📷 Add photo" is greyed on this thread, or null. Only Team and Training photos are uploaded ahead of the message. */
export function photoClosedReason(status: string | undefined, kind: string | undefined): string | null {
  return status === 'closed' && kind !== 'job' ? PHOTO_CLOSED_REASON : null
}

/**
 * Did the first try of an unsent message reach the office after all (the answer was lost, the message made)? A message of
 * mine, made since the first try began, with these words and these pictures. Checked before a retry sends it again, so a
 * retry can never post it twice.
 */
export function sentAlready(messages: TechMessage[], item: Pick<Unsent, 'body' | 'photos' | 'startedAt'>): boolean {
  return messages.some((m) =>
    m.mine && !m.deleted && m.createdAt >= item.startedAt && (m.body ?? '') === item.body &&
    item.photos.every((p) => (p.attachmentId ? m.attachments.some((a) => a.id === p.attachmentId) : m.photoIds.includes(p.key))),
  )
}

/** The photos the server holds for this person that this screen is not already showing (a reload, "← Messages", a discarded message). */
export function heldPhotosToRestore(held: readonly AttachmentRef[], known: ReadonlySet<string>): AttachmentRef[] {
  return held.filter((h) => !known.has(h.id))
}

/** Take back the photos an unsent message was holding on the server. With no signal one stays held; it comes back with its Remove when the thread opens next. */
export async function takeBackHeldPhotos(photos: readonly Staged[], remove: (attachmentId: string) => Promise<unknown>): Promise<void> {
  for (const p of photos) {
    if (p.attachmentId) await remove(p.attachmentId).catch(() => undefined)
  }
}

export function UnsentRow({ unsent, onRetry, onDiscard }: { unsent: Unsent; onRetry?: () => void; onDiscard?: () => void }) {
  return (
    <li className="rounded-lg border border-amber-600 bg-amber-950/40 p-3 text-sm text-white" data-testid="unsent">
      <button type="button" onClick={onRetry} className="block w-full text-left">
        {unsent.body && <span className="block whitespace-pre-wrap break-words">{unsent.body}</span>}
        {unsent.photos.length > 0 && <span className="block text-xs text-slate-300">📷 {unsent.photos.length} photo{unsent.photos.length === 1 ? '' : 's'}</span>}
        <span className="mt-1 block text-xs font-semibold text-amber-200">{unsent.error ?? UNSENT_TEXT}</span>
      </button>
      {onDiscard && (
        <button type="button" onClick={onDiscard} className="mt-2 text-xs text-slate-300 underline">Discard this message</button>
      )}
    </li>
  )
}

function Photo({ load, alt }: { load: () => Promise<Blob>; alt: string }) {
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    let alive = true
    let made: string | null = null
    load().then((blob) => {
      if (!alive) return
      made = URL.createObjectURL(blob)
      setSrc(made)
    }).catch(() => { if (alive) setFailed(true) })
    return () => { alive = false; if (made) URL.revokeObjectURL(made) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  if (failed) return <span className="text-xs text-slate-400">Photo unavailable</span>
  if (!src) return <span className="inline-block h-24 w-24 rounded bg-slate-700" aria-label="Loading photo" />
  return <a href={src} target="_blank" rel="noreferrer"><img src={src} alt={alt} className="h-24 w-24 rounded object-cover" /></a>
}

export function MessageBubble({
  message, visitId, onEdit, onDelete,
}: {
  message: TechMessage
  visitId: string | null
  onEdit?: (id: string, body: string) => Promise<void>
  onDelete?: (id: string) => Promise<void>
}) {
  const [mode, setMode] = useState<'view' | 'edit' | 'delete'>('view')
  const [draft, setDraft] = useState(message.body ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const run = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      setMode('view')
    } catch (err) {
      setError(isNetworkFailure(err) ? 'No signal — try again with bars.' : err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }
  return (
    <li className={`rounded-lg border p-3 text-sm text-white ${message.mine ? 'border-sky-700 bg-sky-950/40' : 'border-slate-700 bg-slate-800'}`} data-message-id={message.id}>
      <p className="text-xs text-slate-400">
        <span className="font-semibold text-slate-200">{message.authorLabel}</span> · {whenText(message.createdAt)}
        {message.editedAt && <span className="text-amber-200"> · edited</span>}
      </p>
      {message.deleted ? (
        <p className="mt-1 text-xs italic text-slate-400">Deleted</p>
      ) : mode === 'edit' ? (
        <div className="mt-1 space-y-2">
          <textarea
            className="w-full rounded border border-slate-600 bg-slate-900 p-2 text-sm text-white"
            rows={3}
            aria-label="Message text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div className="flex gap-2">
            <button
              type="button" disabled={busy || !draft.trim()} onClick={() => void run(async () => { await onEdit?.(message.id, draft.trim()) })}
              className="rounded bg-sky-600 px-3 py-1 text-xs font-medium text-white disabled:opacity-40"
            >
              {busy ? 'Saving…' : 'Save changes'}
            </button>
            <button type="button" onClick={() => { setMode('view'); setError(null) }} className="rounded border border-slate-600 px-3 py-1 text-xs text-slate-200">Cancel</button>
          </div>
          <EditReason draft={draft} />
        </div>
      ) : (
        <>
          {message.body ? <p className="mt-1 whitespace-pre-wrap break-words">{message.body}</p> : null}
          {(message.attachments.length > 0 || message.photoIds.length > 0) && (
            <div className="mt-1 flex flex-wrap gap-2" data-testid="message-photos">
              {message.attachments.map((a) => <Photo key={a.id} load={() => fetchHubAttachment(a.id)} alt="Photo on this message" />)}
              {visitId && message.photoIds.map((id) => <Photo key={id} load={() => fetchVisitPhotoThumb(visitId, id)} alt="Job photo on this message" />)}
            </div>
          )}
        </>
      )}
      {mode === 'delete' && (
        <div className="mt-2 space-y-2 rounded border border-red-800 bg-red-950/40 p-2">
          <p className="text-xs text-red-100">Delete this message? It will show as “Deleted”.</p>
          <div className="flex gap-2">
            <button
              type="button" disabled={busy} onClick={() => void run(async () => { await onDelete?.(message.id) })}
              className="rounded bg-red-700 px-3 py-1 text-xs font-medium text-white disabled:opacity-40"
            >
              {busy ? 'Deleting…' : 'Delete message'}
            </button>
            <button type="button" onClick={() => { setMode('view'); setError(null) }} className="rounded border border-slate-600 px-3 py-1 text-xs text-slate-200">Keep it</button>
          </div>
        </div>
      )}
      {mode === 'view' && !message.deleted && (message.canEdit || message.canDelete) && (
        <div className="mt-2 flex gap-3">
          {message.canEdit && <button type="button" onClick={() => { setDraft(message.body ?? ''); setMode('edit') }} className="text-xs text-sky-300 underline">Edit</button>}
          {message.canDelete && <button type="button" onClick={() => setMode('delete')} className="text-xs text-red-300 underline">Delete</button>}
        </div>
      )}
      {error && <p className="mt-1 text-xs text-red-300">{error}</p>}
    </li>
  )
}

export function MessageThreadScreen({
  threadId, visitId, title, onBack,
}: { threadId?: string; visitId?: string; title: string; onBack: () => void }) {
  const live = useHubLive()
  const [id, setId] = useState<string | null>(threadId ?? null)
  const [detail, setDetail] = useState<TechThreadDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [text, setText] = useState('')
  const [staged, setStaged] = useState<Staged[]>([])
  const [unsent, setUnsent] = useState<Unsent[]>([])
  const [busy, setBusy] = useState(false)
  const markedAt = useRef<string | null>(null)
  // The held photos already on this screen (in the box or in an unsent message), and the ones being fetched back.
  const heldIds = useRef<Set<string>>(new Set())
  const restoring = useRef<Set<string>>(new Set())
  useEffect(() => {
    heldIds.current = new Set([...staged, ...unsent.flatMap((u) => u.photos)].flatMap((p) => (p.attachmentId ? [p.attachmentId] : [])))
  }, [staged, unsent])

  // A job's thread is made the first time it is opened.
  useEffect(() => {
    if (id || !visitId) return
    let alive = true
    openJobThread(visitId)
      .then((r) => { if (alive) setId(r.id) })
      .catch((err) => { if (alive) setError(isNetworkFailure(err) ? 'No signal — open this again with bars.' : err instanceof Error ? err.message : String(err)) })
    return () => { alive = false }
  }, [id, visitId])

  const load = useCallback(async () => {
    if (!id) return
    try {
      const d = await fetchHubThread(id)
      setDetail(d)
      setError(null)
      const lastOther = [...d.messages].reverse().find((m) => !m.mine)
      // `at` is when it became readable (an AI post's approval time), the same clock the server counts unread by.
      const unread = lastOther && (!d.lastReadAt || (lastOther.at ?? lastOther.createdAt) > d.lastReadAt)
      if (unread && markedAt.current !== (lastOther.at ?? lastOther.createdAt)) {
        markedAt.current = lastOther.at ?? lastOther.createdAt
        void markHubThreadRead(id).catch(() => { markedAt.current = null })
      }
      // Photos added here and never sent (a reload, "← Messages", a discarded message): shown again with their Remove.
      for (const held of heldPhotosToRestore(d.staged ?? [], new Set([...heldIds.current, ...restoring.current]))) {
        restoring.current.add(held.id)
        fetchHubAttachment(held.id)
          .then((blob) => setStaged((l) => (l.some((x) => x.attachmentId === held.id) ? l : [...l, { key: held.id, blob, preview: URL.createObjectURL(blob), attachmentId: held.id }])))
          .catch(() => { restoring.current.delete(held.id) })
      }
    } catch (err) {
      setError(isNetworkFailure(err) ? 'No signal — showing what was last loaded.' : err instanceof Error ? err.message : String(err))
    }
  }, [id])
  useEffect(() => { void load() }, [load, live.tick])

  const kind = detail?.thread.kind
  const jobVisitId = detail?.thread.visitId ?? visitId ?? null

  async function addPhoto(file: File) {
    if (!id || !kind) return
    setBusy(true)
    setError(null)
    try {
      const { blob } = await compressReceiptImage(file)
      if (kind === 'job') {
        setStaged((l) => [...l, { key: crypto.randomUUID(), blob, preview: URL.createObjectURL(blob) }])
      } else {
        const saved = await uploadHubAttachment(id, blob)
        setStaged((l) => [...l, { key: saved.id, blob, preview: URL.createObjectURL(blob), attachmentId: saved.id }])
      }
    } catch (err) {
      setError(isNetworkFailure(err) ? 'No signal — add the photo again with bars.' : err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  async function removePhoto(photo: Staged) {
    try {
      if (photo.attachmentId) await removeHubAttachment(photo.attachmentId)
      URL.revokeObjectURL(photo.preview)
      setStaged((l) => l.filter((p) => p.key !== photo.key))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  /** Send now. A job's pictures are filed on the job first (its own photos), then named by the message. */
  async function deliver(body: string, photos: Staged[]): Promise<void> {
    if (!id) throw new Error('This conversation is not open yet.')
    const photoIds: string[] = []
    if (kind === 'job') {
      if (!jobVisitId) throw new Error('This job is not known yet.')
      // The picture's own key is its photo id: a retry sends the same PUT, which updates the one VisitPhoto instead of filing another.
      for (const p of photos) photoIds.push(await uploadJobPhoto(jobVisitId, p.blob, undefined, p.key))
    }
    const attachmentIds = photos.flatMap((p) => (p.attachmentId ? [p.attachmentId] : []))
    await sendHubMessage(id, { body, ...(photoIds.length ? { photoIds } : {}), ...(attachmentIds.length ? { attachmentIds } : {}) })
  }

  async function send() {
    const body = text.trim()
    if ((!body && staged.length === 0) || busy) return
    const photos = staged
    const startedAt = new Date().toISOString()
    setBusy(true)
    setError(null)
    try {
      await deliver(body, photos)
      for (const p of photos) URL.revokeObjectURL(p.preview)
      setText('')
      setStaged([])
      await load()
    } catch (err) {
      if (isNetworkFailure(err)) {
        // Kept on screen, words and pictures, until it goes.
        setUnsent((l) => [...l, { localId: crypto.randomUUID(), body, photos, startedAt }])
        setText('')
        setStaged([])
      } else {
        setError(err instanceof Error ? err.message : String(err))
      }
    } finally {
      setBusy(false)
    }
  }

  /** Did the first try reach the office after all (the answer was lost)? A message of mine, made since, with these words and these pictures. */
  async function alreadySent(item: Unsent): Promise<boolean> {
    if (!id) return false
    return sentAlready((await fetchHubThread(id)).messages, item)
  }

  /** Discard: the words go from the screen and any picture held for them is taken back. With no signal the picture is shown again, with its Remove, the next time this thread opens. */
  async function discard(item: Unsent) {
    setUnsent((l) => l.filter((x) => x.localId !== item.localId))
    await takeBackHeldPhotos(item.photos, removeHubAttachment)
    for (const p of item.photos) URL.revokeObjectURL(p.preview)
  }

  async function retry(item: Unsent) {
    setBusy(true)
    try {
      if (!(await alreadySent(item))) await deliver(item.body, item.photos)
      for (const p of item.photos) URL.revokeObjectURL(p.preview)
      setUnsent((l) => l.filter((u) => u.localId !== item.localId))
      await load()
    } catch (err) {
      setUnsent((l) => l.map((u) => (u.localId === item.localId ? { ...u, error: isNetworkFailure(err) ? undefined : err instanceof Error ? err.message : String(err) } : u)))
    } finally {
      setBusy(false)
    }
  }

  const heading = detail ? (detail.thread.kind === 'team' ? 'Team' : detail.thread.kind === 'training' ? 'Training' : detail.thread.title) : title
  const closedNote = detail?.thread.status === 'closed' ? 'The office closed this thread; sending a message opens it again.' : null
  // A Team or Training photo is uploaded before the message, and the server will not take one into a closed thread.
  const photoClosed = photoClosedReason(detail?.thread.status, kind) !== null

  return (
    <div className="mx-auto max-w-xl space-y-4 p-6 pb-16">
      <button type="button" onClick={onBack} className="text-sm text-sky-300">← {visitId && !threadId ? 'Job site' : 'Messages'}</button>
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-white">{heading}</h1>
        <p className="text-xs text-slate-400" data-testid="live-status">{liveLabel(live.status)}</p>
      </header>
      {error && <p className="rounded-lg bg-slate-800 p-2 text-xs text-amber-200">{error}</p>}
      {closedNote && <p className="text-xs text-slate-400">{closedNote}</p>}
      {!detail && !error && <p className="text-sm text-slate-400">Loading…</p>}
      {detail && (
        <ul className="space-y-2">
          {detail.truncated && <li className="text-xs text-slate-400">Showing the most recent messages.</li>}
          {detail.messages.map((m) => (
            <MessageBubble
              key={m.id}
              message={m}
              visitId={detail.thread.visitId}
              onEdit={async (mid, body) => { await editHubMessage(mid, body); await load() }}
              onDelete={async (mid) => { await deleteHubMessage(mid); await load() }}
            />
          ))}
          {detail.messages.length === 0 && unsent.length === 0 && <li className="text-sm text-slate-400">Nothing has been said here yet.</li>}
          {unsent.map((u) => <UnsentRow key={u.localId} unsent={u} onRetry={() => void retry(u)} onDiscard={() => void discard(u)} />)}
        </ul>
      )}
      <section className="space-y-2 rounded-xl border border-slate-700 bg-slate-800/60 p-4">
        <textarea
          className="w-full rounded border border-slate-600 bg-slate-900 p-2 text-sm text-white placeholder:text-slate-500"
          rows={3}
          placeholder="Write a message"
          aria-label="Message"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        {staged.length > 0 && (
          <ul className="flex flex-wrap gap-2" aria-label="Photos to send">
            {staged.map((p) => (
              <li key={p.key} className="relative">
                <img src={p.preview} alt="Photo to send" className="h-20 w-20 rounded object-cover" />
                <button type="button" onClick={() => void removePhoto(p)} className="absolute right-0 top-0 rounded bg-slate-900/80 px-1.5 text-[11px] text-white">Remove</button>
              </li>
            ))}
          </ul>
        )}
        <PhotoPicker onPick={(f) => void addPhoto(f)} disabled={busy || !detail || staged.length >= 6 || photoClosed} cameraLabel={PHOTO_BUTTON} />
        {photoClosed && <p className="text-xs text-slate-400" data-testid="photo-closed-reason">{PHOTO_CLOSED_REASON}</p>}
        <button
          type="button"
          onClick={() => void send()}
          disabled={busy || !detail || (!text.trim() && staged.length === 0)}
          className="w-full rounded-lg bg-sky-600 p-3 text-sm font-medium text-white disabled:opacity-40"
        >
          {busy ? 'Sending…' : 'Send'}
        </button>
      </section>
    </div>
  )
}
