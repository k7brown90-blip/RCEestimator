/**
 * The live-update stream (work order agent-team, U6): Server-Sent Events over a plain authenticated GET.
 * The CRM reads it at GET /hub/stream (session) and the field app at GET /health-record/hub/stream
 * (technician bearer). Both send the Authorization header like every other request, and the client reads
 * the body with fetch + ReadableStream: an EventSource cannot send a header, and a token in the URL is
 * never allowed. The request is checked by the same gate as any other route BEFORE this runs.
 *
 *   * Each subscriber sees only events for threads its reader may see (visibleThreadWhere, asked of the
 *     database for every event), so a technician on an unassigned job hears nothing about it.
 *   * A technician who is also an approver (U10) passes a second reader, their CRM login's: an event is sent when
 *     EITHER reader may see the thread, so a draft on a customer thread moves their "Needs approval" count. The
 *     technician's own reader is never replaced, so their team and job threads keep working.
 *   * An event is ids only: {type, threadId, messageId}. The client asks the server again for what it shows.
 *   * A heartbeat comment every 25 seconds keeps a proxy from closing an idle stream, and the server ends
 *     every stream after 10 minutes. That is on purpose: the client reconnects through the gate again, so a
 *     session that has expired (8-hour login) or an AI admin that was turned off is cut off within minutes.
 *   * While a stream is down the client polls every 15 seconds, so a missed event costs a few seconds.
 */
import type { Request, Response } from "express";
import type { Prisma } from "@prisma/client";
import { prisma as defaultPrisma } from "../lib/prisma";
import { subscribeHub, type HubBusEvent } from "./hubBus";
import { visibleThreadWhere, type HubReader } from "./hub";

/** Exported so a test can shorten them; production never changes them. */
export const HUB_STREAM_TIMING = { heartbeatMs: 25_000, capMs: 10 * 60_000 };

const writeEvent = (res: Response, name: string, data: unknown): void => {
  res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
};

/**
 * The threads either reader may see. An empty where means "every thread" (an office reader), and Prisma reads an
 * empty object INSIDE an OR as matching nothing, so the two are never OR-ed when one of them is empty.
 */
function visibleToEither(reader: HubReader, alsoReader: HubReader | null): Prisma.HubThreadWhereInput {
  const first = visibleThreadWhere(reader);
  if (!alsoReader) return first;
  const second = visibleThreadWhere(alsoReader);
  if (Object.keys(first).length === 0 || Object.keys(second).length === 0) return {};
  return { OR: [first, second] };
}

export function openHubStream(req: Request, res: Response, reader: HubReader, alsoReader: HubReader | null = null): void {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  req.socket?.setNoDelay(true);
  req.socket?.setTimeout(0);

  // Tells the client it is connected (and how soon to retry if it is not told to stop).
  res.write("retry: 5000\n\n");
  writeEvent(res, "ready", {});

  let closed = false;
  // Events are answered in the order they arrived, one visibility check at a time.
  let queue: Promise<void> = Promise.resolve();

  const unsubscribe = subscribeHub((event: HubBusEvent) => {
    queue = queue.then(async () => {
      if (closed) return;
      try {
        const visible = visibleToEither(reader, alsoReader);
        const seen = await defaultPrisma.hubThread.count({ where: { AND: [{ id: event.threadId }, visible] } });
        if (seen > 0 && !closed) writeEvent(res, "hub", { type: event.type, threadId: event.threadId, messageId: event.messageId });
      } catch {
        // A failed check drops this one event; the client's next refetch or poll catches up.
      }
    });
  });

  const heartbeat = setInterval(() => {
    if (!closed) res.write(": heartbeat\n\n");
  }, HUB_STREAM_TIMING.heartbeatMs);
  const cap = setTimeout(() => finish(), HUB_STREAM_TIMING.capMs);

  function finish(): void {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    clearTimeout(cap);
    unsubscribe();
    try {
      res.end();
    } catch {
      // Already gone.
    }
  }

  req.on("close", finish);
  res.on("error", finish);
}
