/**
 * Web push for the Messages hub (work order agent-team, U7): the transport only. WHO to tell and
 * WHAT it says is services/hubNotifier.ts; this file knows how to keep a device's subscription and how
 * to put one notification on the wire.
 *
 * Switched on by three Railway variables, read here by name only: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY
 * and VAPID_SUBJECT (a mailto: or https: address). While any is unset nothing throws and nothing is
 * sent: `pushConfig()` says why, and the "Turn on notifications on this device" button is greyed with
 * that reason. The private key never leaves this file and is never logged.
 *
 * A notification carries NO customer name, address or phone and no message text: a title, one generic
 * line, the thread id (so a tap can open it) and a tag that folds repeats. A subscription is removed the
 * moment the push service answers 404 or 410 (the device is gone). Other failures are kept on the row
 * (lastError, no endpoint in it) so a dead device is visible, and never fail the write that caused them.
 *
 * A device's push endpoint is a URL this server will POST to, so it is only accepted when it names a
 * real push service over https (the browser vendors' hosts, below). Anything else is refused: the server
 * must never be made to call an address a client chose.
 */
import webpush from "web-push";
import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../lib/prisma";
import { logSystemEvent } from "./systemEvents";

export const PUSH_ENV = { publicKey: "VAPID_PUBLIC_KEY", privateKey: "VAPID_PRIVATE_KEY", subject: "VAPID_SUBJECT" } as const;

export const PUSH_NOT_CONFIGURED_REASON =
  "Notifications are not set up on the server yet. Kyle: add VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT in Railway.";

export interface PushConfig {
  configured: boolean;
  /** The public key a browser needs to subscribe; null while not configured. */
  publicKey: string | null;
  /** Why it is off, in words; null when configured. */
  reason: string | null;
}

const env = (name: string): string => (process.env[name] ?? "").trim();

export function pushConfig(): PushConfig {
  const publicKey = env(PUSH_ENV.publicKey);
  if (!publicKey || !env(PUSH_ENV.privateKey) || !env(PUSH_ENV.subject)) {
    return { configured: false, publicKey: null, reason: PUSH_NOT_CONFIGURED_REASON };
  }
  return { configured: true, publicKey, reason: null };
}

/** The hosts a browser's push service answers on. A subdomain of any of these is accepted. */
const PUSH_HOST_SUFFIXES = [
  "fcm.googleapis.com",
  "push.services.mozilla.com",
  "notify.windows.com",
  "push.apple.com",
] as const;

export function isAllowedPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  return PUSH_HOST_SUFFIXES.some((s) => host === s || host.endsWith(`.${s}`));
}

export class PushError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "PushError";
    this.status = status;
  }
}

export interface SubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

const BASE64URL = /^[A-Za-z0-9_-]{8,200}$/;

/** Keep (or move to this person) one device's subscription. The endpoint is unique, so a device is one row. */
export async function saveSubscription(
  readerKey: string, input: SubscriptionInput, userAgent: string | null, db: PrismaClient = defaultPrisma,
): Promise<void> {
  if (!pushConfig().configured) throw new PushError(PUSH_NOT_CONFIGURED_REASON, 409);
  if (typeof input.endpoint !== "string" || input.endpoint.length > 1000 || !isAllowedPushEndpoint(input.endpoint)) {
    throw new PushError("That is not a notification address this server can use.");
  }
  if (!BASE64URL.test(input.keys?.p256dh ?? "") || !BASE64URL.test(input.keys?.auth ?? "")) {
    throw new PushError("The device's notification keys are not valid.");
  }
  const ua = userAgent ? userAgent.slice(0, 300) : null;
  await db.hubPushSubscription.upsert({
    where: { endpoint: input.endpoint },
    create: { readerKey, endpoint: input.endpoint, p256dh: input.keys.p256dh, auth: input.keys.auth, userAgent: ua },
    update: { readerKey, p256dh: input.keys.p256dh, auth: input.keys.auth, userAgent: ua, lastError: null },
  });
}

/** Turn off notifications on one device. Only the person it belongs to can remove it. */
export async function removeSubscription(readerKey: string, endpoint: string, db: PrismaClient = defaultPrisma): Promise<boolean> {
  const gone = await db.hubPushSubscription.deleteMany({ where: { endpoint, readerKey } });
  return gone.count > 0;
}

/**
 * Forget every device this person has subscribed. Called when their access is cut off (a technician's token
 * is rotated): the old phone must stop hearing about their jobs the moment it can no longer sign in.
 */
export async function removeAllSubscriptionsFor(readerKey: string, db: PrismaClient = defaultPrisma): Promise<number> {
  const gone = await db.hubPushSubscription.deleteMany({ where: { readerKey } });
  return gone.count;
}

/**
 * Is THIS device (its endpoint) subscribed for THIS person? The button reads "Notifications on" from this, not from
 * "the person has some device": a device whose row was removed (the push service said it was gone) or moved to
 * someone else who signed in on the same browser is not on for this person. The endpoint is a capability URL, so
 * it travels in a request body, never in an address.
 */
export async function isSubscribedHere(readerKey: string, endpoint: string, db: PrismaClient = defaultPrisma): Promise<boolean> {
  return (await db.hubPushSubscription.count({ where: { readerKey, endpoint } })) > 0;
}

/** Does this person have a device subscribed? */
export async function subscriptionCount(readerKey: string, db: PrismaClient = defaultPrisma): Promise<number> {
  return db.hubPushSubscription.count({ where: { readerKey } });
}

/** What goes on the wire. The service worker reads exactly these four. No name, address, phone or text. */
export interface PushPayload {
  title: string;
  body: string;
  /** Where a tap goes. Built per person by `urlFor` in hubNotifier (the CRM and the field app differ). */
  url: string;
  /** Folds repeats: a second notification with the same tag replaces the first. */
  tag: string;
}

export interface PushSend {
  readerKey: string;
  payload: PushPayload;
}

let configuredFor: string | null = null;
function ensureVapid(): boolean {
  const cfg = pushConfig();
  if (!cfg.configured) return false;
  const key = `${cfg.publicKey}|${env(PUSH_ENV.subject)}`;
  if (configuredFor !== key) {
    webpush.setVapidDetails(env(PUSH_ENV.subject), cfg.publicKey as string, env(PUSH_ENV.privateKey));
    configuredFor = key;
  }
  return true;
}

/**
 * Put each notification on every device its person has subscribed. Returns how many were accepted by a
 * push service. Never throws: a notification is a courtesy, and the write that wanted it has committed.
 */
export async function sendPush(sends: readonly PushSend[], db: PrismaClient = defaultPrisma): Promise<number> {
  if (sends.length === 0) return 0;
  try {
    if (!ensureVapid()) return 0;
    const byKey = new Map<string, PushPayload[]>();
    for (const s of sends) byKey.set(s.readerKey, [...(byKey.get(s.readerKey) ?? []), s.payload]);
    const subs = await db.hubPushSubscription.findMany({ where: { readerKey: { in: [...byKey.keys()] } } });
    let delivered = 0;
    for (const sub of subs) {
      for (const payload of byKey.get(sub.readerKey) ?? []) {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            JSON.stringify(payload),
            { TTL: 60 * 60 },
          );
          delivered += 1;
          await db.hubPushSubscription.update({ where: { id: sub.id }, data: { lastOkAt: new Date(), lastError: null } }).catch(() => undefined);
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            // The device is gone for good: forget it.
            await db.hubPushSubscription.deleteMany({ where: { id: sub.id } }).catch(() => undefined);
            break;
          }
          const why = `push failed${status ? ` (${status})` : ""}`;
          await db.hubPushSubscription.update({ where: { id: sub.id }, data: { lastError: why } }).catch(() => undefined);
        }
      }
    }
    return delivered;
  } catch (err) {
    logSystemEvent("error", "hub", `push failed: ${err instanceof Error ? err.message : String(err)}`);
    return 0;
  }
}
