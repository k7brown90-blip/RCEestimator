/**
 * Where a notification tap lands in the field app (work order agent-team U7; W2-D, Kyle 2026-11-23 item 6). The server's push URL is
 * `/field/?thread=<id>` for a message, and `/field/?approvals=1` for "n messages need approval": an approver's tap opens the
 * "Waiting for approval" list, never the customer thread behind a draft (a technician cannot open it). Read once on load by
 * AssignmentScreen, which then removes both words from the address so a refresh does not reopen them.
 */
export interface MessagesLaunch {
  /** A thread id to open, or null. */
  thread: string | null
  /** True to open the approval list. */
  approvals: boolean
  /** The query string without those two words (no leading "?"), for the address bar. */
  rest: string
}

export function readMessagesLaunch(search: string): MessagesLaunch {
  const params = new URLSearchParams(search)
  const thread = params.get('thread') || null
  const approvals = params.get('approvals') === '1'
  params.delete('thread')
  params.delete('approvals')
  return { thread, approvals, rest: params.toString() }
}
