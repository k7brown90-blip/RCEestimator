/**
 * Whether the live Messages stream is up (work order agent-team, U6): the one small store the screens read.
 * lib/hubStream.ts writes it; lib/hubQueries.ts and the Messages screens read it (they cannot import the
 * connection itself, which imports the queries).
 */
import { useSyncExternalStore } from "react";
import { STREAM_POLL_MS, type StreamStatus } from "../../../shared/hub/streamClient";

let status: StreamStatus = "connecting";
const listeners = new Set<() => void>();

export function setHubStreamStatus(next: StreamStatus): void {
  if (next === status) return;
  status = next;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

/** "live" once the server has said so; anything else is "not live" to the screens. */
export function useHubStreamStatus(): StreamStatus {
  return useSyncExternalStore(subscribe, () => status, () => "connecting" as StreamStatus);
}

/** What the hub queries use as `refetchInterval`: nothing while the stream is live, 15 seconds otherwise. */
export function useHubPollMs(): number | false {
  return useHubStreamStatus() === "live" ? false : STREAM_POLL_MS;
}

/** The words the Messages page header shows. */
export const streamLabel = (s: StreamStatus): string => (s === "live" ? "Live" : "Reconnecting…");
