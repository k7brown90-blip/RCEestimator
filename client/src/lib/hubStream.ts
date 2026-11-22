/**
 * Live Messages in the CRM (work order agent-team, U6). ONE connection per open CRM tab, started by the
 * AppShell (`useHubStreamConnection`), so the nav badge, the Messages page, a Thread drawer and the record
 * conversations all hear the same thing. The connection itself is shared/hub/streamClient.ts (fetch +
 * ReadableStream with the session's Authorization header; no EventSource, no token in the URL).
 *
 * What a screen does with it:
 *   * an event says "something changed in this conversation": every hub query is invalidated (refreshHub), so
 *     the screens ask the server again, and the server answers by the one visibility rule;
 *   * while the stream is NOT live, `useHubPollMs()` (lib/hubStreamStatus.ts) is 15 seconds and the hub queries
 *     poll; while it is live it is `false` and they do not. The Messages page header shows "Live" or "Reconnecting…".
 */
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { apiBase, authHeaders } from "./api";
import { refreshHub } from "./hubQueries";
import { setHubStreamStatus } from "./hubStreamStatus";
import { startHubStream } from "../../../shared/hub/streamClient";

/**
 * Open the stream while this component is mounted (the AppShell). Does nothing when nobody is signed in (no
 * token), so the login screen and the tests that render no session make no request.
 */
export function useHubStreamConnection(): void {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (typeof localStorage === "undefined" || !localStorage.getItem("rce_token")) return undefined;
    let pending: ReturnType<typeof setTimeout> | null = null;
    // A burst of events (several messages at once) is one refresh.
    const changed = () => {
      if (pending !== null) return;
      pending = setTimeout(() => { pending = null; refreshHub(queryClient); }, 150);
    };
    const stop = startHubStream({
      url: `${apiBase()}/hub/stream`,
      headers: authHeaders,
      onStatus: (next) => {
        setHubStreamStatus(next);
        // Coming back after a gap: ask once for everything that was missed.
        if (next === "live") changed();
      },
      onChange: changed,
    });
    return () => {
      stop();
      if (pending !== null) clearTimeout(pending);
      setHubStreamStatus("connecting");
    };
  }, [queryClient]);
}
