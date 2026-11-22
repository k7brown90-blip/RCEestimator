/**
 * Messages page header (work order agent-team, U7): "Turn on notifications on this device", then
 * "Notifications on ✓ · Turn off". Click path from the Dashboard: left nav "Messages" -> the button in the page
 * header (one click).
 *
 * Greyed WITH the reason beside it, never hidden: a browser that cannot do push, an iPhone where RCE is not on the
 * Home Screen yet ("On iPhone, add RCE to the Home Screen first"), a server where Kyle has not set the three
 * VAPID variables in Railway, or a site the person blocked. Turning it off is the exit, on the same button.
 * What a notification says carries no customer name, address or phone (services/hubNotifier.ts).
 *
 * The AI admin is never notified by push, so for that session the button is greyed with that reason.
 */
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useSession } from "../lib/session";
import { currentPushEndpoint, pushBlockedReason, readPushEnv, turnOffPush, turnOnPush } from "../../../shared/hub/pushClient";

export const PUSH_AI_ADMIN_REASON = "Notifications are for people, not the AI admin.";
const KEY = ["hub-push-key"] as const;

export function NotificationsButton() {
  const queryClient = useQueryClient();
  const session = useSession();
  const { data: server } = useQuery({ queryKey: KEY, queryFn: () => api.hubPushKey(), retry: false });
  const [here, setHere] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Is THIS device's address held for THIS person? (The key answer only says the person has SOME device; a device
  // whose row was removed, or that moved to someone else on the same browser, is not on for them.)
  useEffect(() => {
    let alive = true;
    void (async () => {
      const endpoint = await currentPushEndpoint();
      let onHere = false;
      if (endpoint !== null) {
        try {
          onHere = (await api.hubPushHere(endpoint)).subscribedHere === true;
        } catch {
          onHere = false;
        }
      }
      if (alive) setHere(onHere);
    })();
    return () => { alive = false; };
  }, [server?.subscribed]);

  const reason = session?.kind === "ai-admin" ? PUSH_AI_ADMIN_REASON : pushBlockedReason(readPushEnv(), server);
  // A person who blocked notifications in the browser can still turn this device OFF if it is on.
  const on = here === true;

  async function turnOn() {
    if (!server?.publicKey) return;
    setBusy(true);
    setError(null);
    try {
      await turnOnPush(server.publicKey, (sub) => api.hubPushSubscribe(sub));
      setHere(true);
      void queryClient.invalidateQueries({ queryKey: KEY });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function turnOff() {
    setBusy(true);
    setError(null);
    try {
      await turnOffPush((endpoint) => api.hubPushUnsubscribe(endpoint));
      setHere(false);
      void queryClient.invalidateQueries({ queryKey: KEY });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (on) {
    return (
      <span className="flex flex-wrap items-center gap-2 text-xs text-rce-soft" data-testid="notifications-on">
        <span className="font-semibold text-green-800">Notifications on ✓</span>
        <button type="button" className="btn btn-secondary px-2 py-1 text-xs min-h-0" disabled={busy} onClick={() => void turnOff()}>
          {busy ? "Turning off…" : "Turn off"}
        </button>
        {error && <span className="text-red-600">{error}</span>}
      </span>
    );
  }
  return (
    <span className="flex flex-wrap items-center gap-2 text-xs text-rce-muted">
      <button
        type="button"
        className="btn btn-secondary px-2 py-1 text-xs min-h-0"
        disabled={busy || reason !== null || !server?.publicKey}
        title={reason ?? "Get a notification on this device when something needs you"}
        onClick={() => void turnOn()}
      >
        {busy ? "Turning on…" : "Turn on notifications on this device"}
      </button>
      {reason && <span data-testid="notifications-reason">{reason}</span>}
      {error && <span className="text-red-600">{error}</span>}
    </span>
  );
}
