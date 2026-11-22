/**
 * The Messages hub's live-update bus (work order agent-team, U6): an in-process emitter that says
 * "something changed in this conversation" to every open stream (services/hubStream.ts).
 *
 * What travels is IDS ONLY: the kind of change, the thread and (when there is one) the message. Never
 * a name, a text, a phone or a file. A screen that hears it asks the server again for what it shows, and
 * the server answers through the one visibility rule, so nobody learns anything from the bus itself.
 *
 * Who publishes, and nobody else: services/hub.ts - fanOutMessage (every new message, whatever its
 * status, from the one fan-out call site, AFTER its transaction commits, so a screen that refetches on the
 * event finds the row), editOwnMessage and softDeleteMessage, setThreadStatus, renameThread, markThreadRead (a
 * person's other screens move their badge) and announceThreadMoved (a lead's conversation merged or handed back, said by
 * the caller after its transaction commits); announceDecision (below), called by the one
 * decide path (hubEvents emitHubEventSafe for approval.decided, and hubSend for what a send settled as); and
 * services/hubAttachments.ts when a photo that was added is taken back. No route publishes. One process only: Railway runs one instance, and a missed event
 * costs nothing because every client also polls every 15 seconds while its stream is down.
 */
import { EventEmitter } from "node:events";
import { prisma } from "../lib/prisma";

export type HubBusType = "message" | "approval" | "changed";

export interface HubBusEvent {
  type: HubBusType;
  threadId: string;
  messageId: string | null;
}

const bus = new EventEmitter();
// One listener per open stream: there is no sensible ceiling, and Node's default of 10 would warn.
bus.setMaxListeners(0);

const CHANNEL = "hub";

/** Tell every open stream. Never throws: a broken listener must not fail the write that published. */
export function publishHubChange(event: HubBusEvent): void {
  try {
    bus.emit(CHANNEL, event);
  } catch {
    // A listener threw; the write that published has already committed.
  }
}

/** Listen for changes. Returns the function that stops listening (a stream calls it when it ends). */
export function subscribeHub(listener: (event: HubBusEvent) => void): () => void {
  bus.on(CHANNEL, listener);
  return () => { bus.off(CHANNEL, listener); };
}

/** How many streams are listening (for tests and the shutdown check). */
export function hubListenerCount(): number {
  return bus.listenerCount(CHANNEL);
}

/**
 * A decision was made on a draft (approved, edited, rejected, blocked, sent, failed): tell the open
 * screens so the queue and the badge move. Called from the ONE decide path: hubEvents emitHubEventSafe for
 * approval.decided (every decision site goes through it) and hubSend for what the send settled as.
 * Fire-and-forget: it reads the message's thread and publishes; a failure is silent.
 */
export function announceDecision(messageId: string): void {
  void (async () => {
    try {
      const row = await prisma.hubMessage.findUnique({ where: { id: messageId }, select: { threadId: true } });
      if (row) publishHubChange({ type: "approval", threadId: row.threadId, messageId });
    } catch {
      // The decision has been written; a missed live update is covered by the client's polling.
    }
  })();
}
