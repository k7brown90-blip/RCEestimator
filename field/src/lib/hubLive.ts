/**
 * Live Messages on the phone (work order agent-team, U6). ONE connection for the whole app, shared by every
 * screen that shows messages (the home screen's "Messages (n new)", the Job site's "Job messages (n)", the
 * Messages list and a thread): the first screen to ask opens it, the last one to leave closes it. The
 * connection itself is shared/hub/streamClient.ts (fetch + ReadableStream with the technician's bearer in the
 * Authorization header - no EventSource, no token in the address).
 *
 * A screen reads `useHubLive()`: `tick` goes up each time the server says something changed, and ALSO every 15
 * seconds while the stream is not live (so a dropped stream costs seconds, not messages). The screen asks the
 * server again whenever `tick` changes. `status` is "live" or not, for the words under the Messages heading.
 */
import { useEffect, useSyncExternalStore } from 'react'
import { STREAM_POLL_MS, startHubStream, type StreamStatus } from '../../../shared/hub/streamClient'
import { hubStreamRequest } from './crmSync'

interface Snapshot {
  status: StreamStatus
  tick: number
}

let snapshot: Snapshot = { status: 'connecting', tick: 0 }
const listeners = new Set<() => void>()
let users = 0
let stop: (() => void) | null = null
let poll: ReturnType<typeof setInterval> | null = null
let retryOpen: ReturnType<typeof setTimeout> | null = null

function publish(next: Snapshot): void {
  snapshot = next
  for (const listener of listeners) listener()
}

function open(): void {
  const request = hubStreamRequest()
  if (!request) {
    // This phone is not connected to the office yet (the QR was not scanned): look again in a few seconds.
    retryOpen = setTimeout(() => { retryOpen = null; if (users > 0 && stop === null) open() }, 5000)
    return
  }
  stop = startHubStream({
    url: request.url,
    headers: request.headers,
    onStatus: (status) => publish({ status, tick: status === 'live' && snapshot.status !== 'live' ? snapshot.tick + 1 : snapshot.tick }),
    onChange: () => publish({ ...snapshot, tick: snapshot.tick + 1 }),
  })
  // While the stream is down the screens still look again every 15 seconds.
  poll = setInterval(() => {
    if (snapshot.status !== 'live') publish({ ...snapshot, tick: snapshot.tick + 1 })
  }, STREAM_POLL_MS)
}

function close(): void {
  if (retryOpen !== null) clearTimeout(retryOpen)
  retryOpen = null
  stop?.()
  stop = null
  if (poll !== null) clearInterval(poll)
  poll = null
  snapshot = { status: 'connecting', tick: snapshot.tick }
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Keep the stream open while this component is on screen. */
export function useHubLive(): Snapshot {
  useEffect(() => {
    users += 1
    if (users === 1) open()
    return () => {
      users -= 1
      if (users === 0) close()
    }
  }, [])
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot)
}

export const liveLabel = (status: StreamStatus): string => (status === 'live' ? 'Live' : 'Reconnecting…')
