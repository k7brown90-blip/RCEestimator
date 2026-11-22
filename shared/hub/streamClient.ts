/**
 * The Messages live stream's CLIENT half (work order agent-team, U6), ONE implementation for the CRM
 * (client/src/lib/hubStream.ts) and the field app (field/src/lib/hubStream.ts). The server half is
 * src/services/hubStream.ts.
 *
 * It is fetch + ReadableStream, NOT EventSource: an EventSource cannot send an Authorization header, and a
 * token in the URL is never allowed. The caller hands in `headers()` (the same bearer every other request
 * carries, renewed the same way), and this builds the request with those headers and a URL that has no
 * credentials in it.
 *
 * Behaviour:
 *   * `live` once the server says it is ready; an event of type `hub` tells the caller something changed (ids
 *     only: the caller asks the server again for what it shows);
 *   * the server ends every stream after 10 minutes on purpose (so an expired session is cut off); that clean
 *     end reconnects at once and the status stays `live`;
 *   * a failed connection or a refusal is `reconnecting`, retried 2, 4, 8 then every 15 seconds. While not
 *     `live` the callers poll every 15 seconds (STREAM_POLL_MS), so a dropped stream costs a few seconds;
 *   * a connection that goes silent is dead: the server writes a heartbeat every 25 seconds, so IDLE_MS (60 s, more than
 *     two missed heartbeats) with no bytes at all aborts it and it reconnects as `reconnecting`, which also turns the
 *     15-second polling back on. Without this a half-open socket (Wi-Fi to LTE, a sleeping laptop) would read "Live"
 *     for as long as the operating system takes to give up;
 *   * a 401 or 403 also calls `onRefused` (the caller decides whether that means "sign in again").
 */

export type StreamStatus = "connecting" | "live" | "reconnecting";

export interface HubStreamChange {
  type: string;
  threadId: string;
  messageId: string | null;
}

/** How often a screen asks the server again while the stream is down. */
export const STREAM_POLL_MS = 15_000;

/** No bytes (not even a heartbeat) for this long: the connection is dead. More than two of the server's 25 s heartbeats. */
export const IDLE_MS = 60_000;
const RETRY_MS = [2_000, 4_000, 8_000, 15_000];
const CLEAN_END_RECONNECT_MS = 250;

export interface SseEvent {
  name: string;
  data: string;
}

/** A Server-Sent-Events parser: feed it chunks as they arrive, it calls `onEvent` once per complete event. */
export function createSseParser(onEvent: (event: SseEvent) => void): { push(chunk: string): void } {
  let buffer = "";
  return {
    push(chunk: string) {
      buffer += chunk.replace(/\r\n/g, "\n");
      let at = buffer.indexOf("\n\n");
      while (at !== -1) {
        const block = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        let name = "message";
        const data: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith(":")) continue; // a comment: the heartbeat
          if (line.startsWith("event:")) name = line.slice(6).trim();
          else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
        }
        if (data.length > 0) onEvent({ name, data: data.join("\n") });
        at = buffer.indexOf("\n\n");
      }
    },
  };
}

export interface HubStreamOptions {
  /** The stream's address, relative or absolute. Never carries a credential. */
  url: string;
  /** The Authorization header (and nothing else secret), asked for on every (re)connect so a renewed token is used. */
  headers: () => Record<string, string>;
  onStatus: (status: StreamStatus) => void;
  onChange: (change: HubStreamChange) => void;
  /** The server answered 401 or 403. */
  onRefused?: () => void;
  /** Test seams. */
  fetchImpl?: typeof fetch;
  idleMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Start the stream. Returns the function that stops it (the connection is aborted and nothing more is retried). */
export function startHubStream(options: HubStreamOptions): () => void {
  const doFetch = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, ms); }));
  let stopped = false;
  let controller: AbortController | null = null;
  let failures = 0;
  const idleMs = options.idleMs ?? IDLE_MS;

  async function run(): Promise<void> {
    options.onStatus("connecting");
    while (!stopped) {
      let cleanEnd = false;
      let idle: ReturnType<typeof setTimeout> | null = null;
      try {
        const ctl = new AbortController();
        controller = ctl;
        // Watches the whole attempt (the connect too): every chunk, heartbeat included, pushes the deadline back.
        const arm = (): void => {
          if (idle) clearTimeout(idle);
          idle = setTimeout(() => ctl.abort(), idleMs);
        };
        arm();
        const response = await doFetch(options.url, {
          headers: { Accept: "text/event-stream", ...options.headers() },
          signal: ctl.signal,
          cache: "no-store",
        });
        if (stopped) return;
        if (response.status === 401 || response.status === 403) options.onRefused?.();
        if (!response.ok || !response.body) throw new Error(`stream refused (${response.status})`);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        const parser = createSseParser((event) => {
          if (event.name === "ready") {
            failures = 0;
            options.onStatus("live");
          } else if (event.name === "hub") {
            try {
              const change = JSON.parse(event.data) as HubStreamChange;
              if (typeof change.threadId === "string") options.onChange(change);
            } catch {
              // A malformed event is skipped; the next poll or event catches up.
            }
          }
        });
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          arm();
          parser.push(decoder.decode(value, { stream: true }));
        }
        cleanEnd = true;
      } catch {
        if (stopped) return;
      } finally {
        if (idle) clearTimeout(idle);
      }
      if (stopped) return;
      if (cleanEnd) {
        await sleep(CLEAN_END_RECONNECT_MS);
      } else {
        options.onStatus("reconnecting");
        await sleep(RETRY_MS[Math.min(failures, RETRY_MS.length - 1)]!);
        failures += 1;
      }
    }
  }

  void run();
  return () => {
    stopped = true;
    controller?.abort();
  };
}
