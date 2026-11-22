/**
 * The Messages hub's queries (work order agent-team, U2/U3), defined ONCE so a screen that changes
 * something refreshes every screen that shows it, and so no two components cache different
 * responses under one key (tests/queryKeyCollisions.test.ts).
 *
 * `["hub-timeline", ...]` is one record's conversation, `["hub-threads", ...]` the Messages page,
 * `["hub-thread", id]` one thread, `["hub-badge"]` the nav badge. Anything that writes to a
 * conversation calls `refreshHub` so all four stay true together.
 *
 * Live (U6): while the Messages stream is up (lib/hubStream.ts) nothing here polls - an event refreshes them
 * all. While it is down each one asks again every 15 seconds (useHubPollMs), so a dropped stream costs seconds.
 */
import { useQuery, type QueryClient } from "@tanstack/react-query";
import { api } from "./api";
import { useHubPollMs } from "./hubStreamStatus";

export type TimelineKey = "customerId" | "leadId" | "visitId" | "propertyId";

/** One record's conversation. The ONE place that reads it. */
export function useHubTimeline(key: TimelineKey, id: string) {
  const pollMs = useHubPollMs();
  return useQuery({
    queryKey: ["hub-timeline", { key, id }],
    queryFn: () => api.hubTimeline({ [key]: id }),
    enabled: Boolean(id),
    refetchInterval: pollMs,
  });
}

/** The Messages nav badge. Live from the stream; polled every 15 seconds only while the stream is down. */
export function useHubBadge() {
  const pollMs = useHubPollMs();
  return useQuery({
    queryKey: ["hub-badge"],
    queryFn: () => api.hubBadge(),
    refetchInterval: pollMs,
    retry: false,
  });
}

/**
 * The approval cards (U4): the drafts waiting for a decision ("pending"), or every card of one
 * conversation including the decided ones ("all" with a threadId). The ONE place that reads them, so the
 * queue, the Thread drawer and the record conversation share one answer.
 */
export function useHubApprovals(filter: { status?: "pending" | "all"; threadId?: string } = {}, enabled = true) {
  const status = filter.status ?? "pending";
  const pollMs = useHubPollMs();
  return useQuery({
    queryKey: ["hub-approvals", { status, threadId: filter.threadId ?? null }],
    queryFn: () => api.hubApprovals({ status, threadId: filter.threadId }),
    enabled,
    retry: false,
    refetchInterval: pollMs,
  });
}

/** After anything written to a conversation: every screen that shows one reads it again. */
export function refreshHub(queryClient: QueryClient): void {
  for (const key of [["hub-timeline"], ["hub-threads"], ["hub-thread"], ["hub-badge"], ["hub-approvals"], ["hub-audit"]]) {
    void queryClient.invalidateQueries({ queryKey: key });
  }
}
