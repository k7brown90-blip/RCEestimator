/**
 * The live Messages stream, client half (work order agent-team, U6): shared/hub/streamClient.ts as the CRM
 * uses it. fetch + ReadableStream with the Authorization header - never an EventSource, never a token in the
 * URL. Pinned: events parse across chunk boundaries; the status goes live on "ready"; a change event reaches
 * the caller with ids only; a clean end of the stream reconnects at once and stays live; a failure is
 * "Reconnecting…" and is retried with a growing wait; a 401 is reported; stopping aborts the request; the
 * hub queries poll every 15 seconds only while the stream is not live.
 */
import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { createSseParser, startHubStream, STREAM_POLL_MS, type HubStreamChange, type StreamStatus } from "../../../shared/hub/streamClient";
import { setHubStreamStatus, streamLabel, useHubPollMs, useHubStreamStatus } from "./hubStreamStatus";

const enc = new TextEncoder();
const streamOf = (chunks: string[], thenHang = false): Response => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c));
      if (!thenHang) controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
};
const tick = (ms = 10) => new Promise<void>((r) => { setTimeout(r, ms); });
async function until(pred: () => boolean, ms = 1500): Promise<void> {
  const end = Date.now() + ms;
  while (!pred() && Date.now() < end) await tick(5);
}

describe("the SSE parser", () => {
  it("joins an event split across chunks, skips the heartbeat comment, and takes the event name", () => {
    const seen: Array<{ name: string; data: string }> = [];
    const parser = createSseParser((e) => seen.push(e));
    parser.push("retry: 5000\n\nevent: hub\nda");
    parser.push('ta: {"type":"message","threadId":"t1","messageId":"m1"}\n\n: heartbeat\n\n');
    parser.push("event: ready\r\ndata: {}\r\n\r\n");
    expect(seen).toEqual([
      { name: "hub", data: '{"type":"message","threadId":"t1","messageId":"m1"}' },
      { name: "ready", data: "{}" },
    ]);
  });
});

describe("startHubStream", () => {
  const run = (fetchImpl: typeof fetch, extra: Partial<Parameters<typeof startHubStream>[0]> = {}) => {
    const statuses: StreamStatus[] = [];
    const changes: HubStreamChange[] = [];
    const urls: string[] = [];
    const sent: Array<Record<string, string>> = [];
    const stop = startHubStream({
      url: "/api/hub/stream",
      headers: () => ({ Authorization: "Bearer session-token" }),
      onStatus: (s) => statuses.push(s),
      onChange: (c) => changes.push(c),
      fetchImpl: ((input: RequestInfo | URL, init?: RequestInit) => {
        urls.push(String(input));
        sent.push(init?.headers as Record<string, string>);
        return fetchImpl(input, init);
      }) as typeof fetch,
      sleep: () => tick(1),
      ...extra,
    });
    return { statuses, changes, urls, sent, stop };
  };

  it("goes live on ready, hands over a change with ids only, and sends the token in the header, never the URL", async () => {
    const f = vi.fn(async () => streamOf(['event: ready\ndata: {}\n\nevent: hub\ndata: {"type":"message","threadId":"t1","messageId":"m1"}\n\n'], true));
    const s = run(f as unknown as typeof fetch);
    await until(() => s.changes.length > 0);
    s.stop();
    expect(s.statuses).toContain("live");
    expect(s.changes).toEqual([{ type: "message", threadId: "t1", messageId: "m1" }]);
    expect(s.urls).toEqual(["/api/hub/stream"]);
    expect(s.sent[0]).toMatchObject({ Authorization: "Bearer session-token", Accept: "text/event-stream" });
    expect(s.urls.join()).not.toMatch(/token|session/i);
  });

  it("reconnects at once when the server ends the stream on purpose (its 10-minute cap), staying live", async () => {
    let calls = 0;
    const f = vi.fn(async () => { calls += 1; return streamOf(["event: ready\ndata: {}\n\n"], calls >= 3); });
    const s = run(f as unknown as typeof fetch);
    await until(() => calls >= 3);
    s.stop();
    expect(calls).toBeGreaterThanOrEqual(3);
    expect(s.statuses).not.toContain("reconnecting");
  });

  it("says Reconnecting after a failure, retries with a longer wait, and is live again when it works", async () => {
    let calls = 0;
    const waits: number[] = [];
    const f = vi.fn(async () => {
      calls += 1;
      if (calls <= 3) throw new Error("offline");
      return streamOf(["event: ready\ndata: {}\n\n"], true);
    });
    const s = run(f as unknown as typeof fetch, { sleep: async (ms) => { waits.push(ms); await tick(1); } });
    await until(() => s.statuses.at(-1) === "live");
    s.stop();
    expect(s.statuses).toContain("reconnecting");
    expect(s.statuses.at(-1)).toBe("live");
    expect(waits.slice(0, 3)).toEqual([2000, 4000, 8000]);
  });

  it("reports a refusal (401) and keeps trying only slowly", async () => {
    const refused = vi.fn();
    const f = vi.fn(async () => new Response("no", { status: 401 }));
    const s = run(f as unknown as typeof fetch, { onRefused: refused });
    await until(() => refused.mock.calls.length > 0);
    s.stop();
    expect(refused).toHaveBeenCalled();
    expect(s.statuses).toContain("reconnecting");
  });

  it("treats a connection that goes silent as dead: no bytes (not even a heartbeat) for the idle limit aborts it, says Reconnecting, and connects again", async () => {
    let calls = 0;
    const f = vi.fn(async (_u: unknown, init?: RequestInit) => {
      calls += 1;
      // A half-open socket: ready arrives, then nothing at all. Only the client's own abort ends the read.
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(enc.encode("event: ready\ndata: {}\n\n"));
          init?.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
        },
      });
      return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    });
    const s = run(f as unknown as typeof fetch, { idleMs: 40 });
    await until(() => s.statuses.includes("live"));
    expect(s.statuses.at(-1)).toBe("live");
    await until(() => s.statuses.includes("reconnecting"), 1500);
    await until(() => calls >= 2, 1500);
    s.stop();
    // Live, then silence, then Reconnecting (so the screens poll again), then a fresh connection.
    expect(s.statuses.indexOf("reconnecting")).toBeGreaterThan(s.statuses.indexOf("live"));
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  it("keeps a stream that stays quiet only between heartbeats", async () => {
    let calls = 0;
    const f = vi.fn(async (_u: unknown, init?: RequestInit) => {
      calls += 1;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(enc.encode("event: ready\ndata: {}\n\n"));
          const beat = setInterval(() => controller.enqueue(enc.encode(": heartbeat\n\n")), 15);
          init?.signal?.addEventListener("abort", () => { clearInterval(beat); controller.error(new DOMException("aborted", "AbortError")); });
        },
      });
      return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
    });
    const s = run(f as unknown as typeof fetch, { idleMs: 60 });
    await until(() => s.statuses.includes("live"));
    await tick(250);
    s.stop();
    expect(calls).toBe(1);
    expect(s.statuses).not.toContain("reconnecting");
  });

  it("stops: the request is aborted and nothing more is asked for", async () => {
    let aborted = false;
    const f = vi.fn(async (_u: unknown, init?: RequestInit) => {
      init?.signal?.addEventListener("abort", () => { aborted = true; });
      return streamOf(["event: ready\ndata: {}\n\n"], true);
    });
    const s = run(f as unknown as typeof fetch);
    await until(() => s.statuses.includes("live"));
    s.stop();
    await until(() => aborted);
    const calls = f.mock.calls.length;
    await tick(30);
    expect(aborted).toBe(true);
    expect(f.mock.calls.length).toBe(calls);
  });
});

describe("what the screens read", () => {
  it("polls every 15 seconds while not live and not at all while live; the header words match", () => {
    const { result } = renderHook(() => ({ status: useHubStreamStatus(), poll: useHubPollMs() }));
    act(() => setHubStreamStatus("reconnecting"));
    expect(result.current).toEqual({ status: "reconnecting", poll: STREAM_POLL_MS });
    expect(streamLabel(result.current.status)).toBe("Reconnecting…");
    act(() => setHubStreamStatus("live"));
    expect(result.current).toEqual({ status: "live", poll: false });
    expect(streamLabel(result.current.status)).toBe("Live");
    act(() => setHubStreamStatus("connecting"));
    expect(result.current.poll).toBe(STREAM_POLL_MS);
  });
});
