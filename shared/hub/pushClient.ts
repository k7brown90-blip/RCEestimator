/**
 * Turning notifications on for THIS device (work order agent-team, U7), ONE implementation for the CRM
 * (client/src/components/NotificationsButton.tsx) and the field app (field/src/ui/components/NotificationsButton.tsx).
 * The server half is src/services/hubPush.ts.
 *
 * `pushBlockedReason` is the sentence printed beside a greyed button: a device that cannot do push, an iPhone
 * where the app is not on the Home Screen yet, a server where Kyle has not set the keys, a browser where the
 * person said no. Null means the button works. Pure: the environment is passed in, so it can be tested.
 */

export interface PushEnv {
  hasServiceWorker: boolean;
  hasPushManager: boolean;
  hasNotification: boolean;
  isIos: boolean;
  /** Running as an installed app (added to the Home Screen), not in a browser tab. */
  isStandalone: boolean;
  permission: "default" | "granted" | "denied";
}

export const PUSH_REASONS = {
  iosHomeScreen: "On iPhone, add RCE to the Home Screen first, then open it from there.",
  unsupported: "This browser cannot show notifications.",
  denied: "Notifications are blocked for this site. Allow them in the browser's site settings, then try again.",
} as const;

export function readPushEnv(): PushEnv {
  const g = globalThis as unknown as {
    navigator?: { userAgent?: string; platform?: string; maxTouchPoints?: number; standalone?: boolean };
    window?: { matchMedia?: (q: string) => { matches: boolean } };
    Notification?: { permission: "default" | "granted" | "denied" };
    PushManager?: unknown;
  };
  const nav = g.navigator;
  const ua = nav?.userAgent ?? "";
  // iPadOS reports as a Mac with a touch screen.
  const isIos = /iPhone|iPad|iPod/.test(ua) || (nav?.platform === "MacIntel" && (nav?.maxTouchPoints ?? 0) > 1);
  const standalone = nav?.standalone === true || g.window?.matchMedia?.("(display-mode: standalone)")?.matches === true;
  return {
    hasServiceWorker: Boolean(nav && "serviceWorker" in nav),
    hasPushManager: g.PushManager !== undefined,
    hasNotification: g.Notification !== undefined,
    isIos,
    isStandalone: standalone,
    permission: g.Notification?.permission ?? "default",
  };
}

/** Why the button is greyed, or null. `server` is GET .../hub/push/key. */
export function pushBlockedReason(env: PushEnv, server: { configured: boolean; reason: string | null } | undefined): string | null {
  // iPhone only does web push from an installed Home Screen app, and then reports the APIs; before that it does not.
  if (env.isIos && !env.isStandalone) return PUSH_REASONS.iosHomeScreen;
  if (!env.hasServiceWorker || !env.hasPushManager || !env.hasNotification) return PUSH_REASONS.unsupported;
  if (server && !server.configured) return server.reason ?? "Notifications are not set up on the server yet.";
  if (env.permission === "denied") return PUSH_REASONS.denied;
  return null;
}

/** A VAPID public key (URL-safe base64) as the bytes the browser's subscribe call wants. */
export function applicationServerKey(publicKey: string): Uint8Array {
  const padded = publicKey.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(publicKey.length / 4) * 4, "=");
  const raw = atob(padded);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
  return out;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const ready = navigator.serviceWorker.ready;
  const timeout = new Promise<never>((_, reject) => {
    setTimeout(() => reject(new Error("The app's background worker is not ready yet. Reload the page and try again.")), 8000);
  });
  return Promise.race([ready, timeout]);
}

/** This device's subscription address, or null when it has none. */
export async function currentPushEndpoint(): Promise<string | null> {
  try {
    const sub = await (await registration()).pushManager.getSubscription();
    return sub ? sub.endpoint : null;
  } catch {
    return null;
  }
}

export interface PushSubscriptionBody {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** Ask permission, subscribe this device, hand the subscription to `save`. Returns the device's address. */
export async function turnOnPush(publicKey: string, save: (subscription: PushSubscriptionBody) => Promise<unknown>): Promise<string> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error(PUSH_REASONS.denied);
  const reg = await registration();
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationServerKey(publicKey) as BufferSource });
  const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } };
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    await sub.unsubscribe().catch(() => undefined);
    throw new Error("This browser did not give a usable notification address.");
  }
  try {
    await save({ endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } });
  } catch (err) {
    // The server did not take it: do not leave the device subscribed to nothing.
    await sub.unsubscribe().catch(() => undefined);
    throw err;
  }
  return json.endpoint;
}

/**
 * Turn this device off: tell the server, then drop the browser's subscription. The server answers `removed: false`
 * when this device's address belongs to someone else (another person signed in on the same browser and turned it
 * on): then the browser's subscription is left alone, so one person cannot switch off another's notifications.
 */
export async function turnOffPush(remove: (endpoint: string) => Promise<unknown>): Promise<void> {
  const reg = await registration();
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  const answer = await remove(sub.endpoint);
  const notMine = typeof answer === "object" && answer !== null && (answer as { removed?: unknown }).removed === false;
  if (notMine) return;
  await sub.unsubscribe().catch(() => undefined);
}
