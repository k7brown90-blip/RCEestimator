/**
 * Who hears about a message, and what the notification says (work order agent-team, U7 and U8). The
 * transport is services/hubPush.ts; this file decides the audience and the words.
 *
 *   * A draft waiting for approval -> the people who may approve (`canApprove`: Kyle, and any login Kyle
 *     granted approve_drafts). "1 message needs approval".
 *   * A new message somebody else wrote, in a thread the person may see -> that person. "New message on a
 *     job thread". The author is never told about their own message. A message that went OUT to a customer
 *     (an approved text or email) is not news to the office and is not announced.
 *   * The re-notify (U8) -> the approvers again, once a draft has waited. "2 messages need approval".
 *
 * The words carry no customer name, address or phone and no message text, only the kind of thread. A tap
 * opens the thread: /messages?thread=<id> in the CRM, /field/?thread=<id> in the field app. A thread id is
 * not a credential (every route still checks who is asking). The exception is an approval push to a TECHNICIAN
 * (W2-D, Kyle 2026-11-23 item 6): the draft waits on a customer thread a technician cannot open, so the tap opens
 * the field app's "Waiting for approval" list (/field/?approvals=1) instead.
 *
 * Nothing here can fail a write: with notifications unset it returns at once without touching the
 * database, and every other failure is swallowed (hubPush logs it).
 */
import type { HubMessage, HubThread, PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../lib/prisma";
import { memberGroupIds, readerForKey, visibleThreadWhere, type HubReader } from "./hub";
import { pushConfig, sendPush, type PushPayload, type PushSend } from "./hubPush";

const TITLE = "Red Cedar Messages";

/** Where a tap on the notification goes, for this person's app. */
export function urlFor(reader: Pick<HubReader, "kind">, threadId: string): string {
  const id = encodeURIComponent(threadId);
  return reader.kind === "tech" ? `/field/?thread=${id}` : `/messages?thread=${id}`;
}

/** Where a tap on an APPROVAL notification goes: the office opens the conversation, a technician's phone opens its approval list. */
export const FIELD_APPROVALS_URL = "/field/?approvals=1";
export function approvalUrlFor(reader: Pick<HubReader, "kind">, threadId: string): string {
  return reader.kind === "tech" ? FIELD_APPROVALS_URL : urlFor(reader, threadId);
}

const WHERE: Record<string, string> = {
  job: "New message on a job thread",
  team: "New message in a Team thread",
  training: "New message in a Training thread",
  group: "New message in a group chat",
  dev: "New message in a Dev thread",
  customer: "New customer message",
};

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export function approvalBody(count: number): string {
  return `${plural(count, "message needs", "messages need")} approval`;
}

function payloadFor(reader: Pick<HubReader, "kind">, threadId: string, body: string, tag: string): PushPayload {
  return { title: TITLE, body, url: urlFor(reader, threadId), tag };
}

/** The "n messages need approval" push: same words for everyone, a different tap target per app (approvalUrlFor). */
function approvalPayloadFor(reader: Pick<HubReader, "kind">, threadId: string, count: number, tag: string): PushPayload {
  return { title: TITLE, body: approvalBody(count), url: approvalUrlFor(reader, threadId), tag };
}

/** Every reader key that has a device subscribed, once each. */
async function subscribedKeys(db: PrismaClient): Promise<string[]> {
  const rows = await db.hubPushSubscription.findMany({ select: { readerKey: true }, distinct: ["readerKey"] });
  return rows.map((r) => r.readerKey);
}

/**
 * The subscribed people who may approve what the agents draft. A field phone counts: its subscription is saved as tech:<id> and
 * readerForKey resolves that through the ONE approver rule (hub.approverReaderForTechnician), so Kyle's and an approver's field phone
 * is told, and a plain technician's never is.
 */
export async function approverKeys(db: PrismaClient = defaultPrisma): Promise<Array<{ key: string; reader: HubReader }>> {
  const out: Array<{ key: string; reader: HubReader }> = [];
  for (const key of await subscribedKeys(db)) {
    const found = await readerForKey(key, db);
    if (found?.canApprove) out.push({ key, reader: found.reader });
  }
  return out;
}

/** Tell the approvers that drafts are waiting (U8 re-notify). `threadId` is where a tap goes. */
export async function notifyApprovers(count: number, threadId: string, db: PrismaClient = defaultPrisma): Promise<number> {
  try {
    if (!pushConfig().configured || count <= 0) return 0;
    const sends: PushSend[] = (await approverKeys(db)).map(({ key, reader }) => ({
      readerKey: key, payload: approvalPayloadFor(reader, threadId, count, "approvals"),
    }));
    return await sendPush(sends, db);
  } catch {
    return 0;
  }
}

/**
 * A new message exists (called from the ONE fan-out call site, fanOutMessage). Never throws.
 */
export async function notifyNewMessage(message: HubMessage, thread: HubThread, db: PrismaClient = defaultPrisma): Promise<void> {
  try {
    if (!pushConfig().configured || message.deletedAt) return;

    if (message.status === "pending_approval") {
      const sends: PushSend[] = (await approverKeys(db)).map(({ key, reader }) => ({
        readerKey: key, payload: approvalPayloadFor(reader, thread.id, 1, `approval:${message.id}`),
      }));
      await sendPush(sends, db);
      return;
    }

    if (message.status !== "posted" && message.status !== "received" && message.status !== "sent") return;
    // Something that went OUT to a customer was decided by the office; it is not news to them.
    if (message.direction === "outbound") return;

    const sends: PushSend[] = [];
    for (const key of await subscribedKeys(db)) {
      if (key === message.authorKey) continue;
      const found = await readerForKey(key, db);
      if (!found) continue;
      const { reader } = found;
      // A technician hears only what the crew said to each other, the same filter their list uses.
      if (reader.kind === "tech" && (message.channel !== "in_app" || message.direction !== "internal")) continue;
      const visible = await db.hubThread.count({ where: { AND: [{ id: thread.id }, visibleThreadWhere(reader)] } });
      if (visible === 0) continue;
      // The office sees every group but is told only of the ones it is in (C7); a technician's visibility IS membership.
      if (thread.kind === "group" && reader.kind !== "tech" && !(await memberGroupIds(reader, [thread.id], db)).has(thread.id)) continue;
      sends.push({ readerKey: key, payload: payloadFor(reader, thread.id, WHERE[thread.kind] ?? "New message", `thread:${thread.id}`) });
    }
    await sendPush(sends, db);
  } catch {
    // A notification is a courtesy; the message is already written.
  }
}
