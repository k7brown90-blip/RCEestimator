/**
 * Settings -> "AI auto-send rules" (work order agent-team, BA8; Kyle only). Which kinds of AI message may
 * go out WITHOUT anyone pressing Approve. Every one is OFF until Kyle turns it on here; off means an AI's customer
 * messages and Training replies wait for someone to press Approve. W2: AI posts in the Team, group and crew chats are NOT here -
 * they are set per key ("Team posts publish immediately", Settings -> Agent keys) - and nothing here sends while Agent access is not On.
 *
 * Click path from the Dashboard: left nav "Settings" -> scroll to "AI auto-send rules", under "Agent
 * events" (two clicks).
 *
 *   * One switch per category the send-type registry marks eligible (shared/hub/autoSendCategories.ts).
 *   * Turning one ON asks "Messages in this category will go out without anyone pressing Approve. Turn
 *     on?". Turning it OFF is one click: that is the exit.
 *   * A switch alone sends nothing. The server-side gate (AUTOMATED_CUSTOMER_SENDS_HUB_AUTOSEND in
 *     Railway) must be on too, and the card says so while it is not.
 *   * Even then a draft goes out only if it is short, names no dollar amount and the customer may be
 *     contacted that way; the rest still wait for a person (services/hubAutoSend.ts).
 *
 * Kyle only. The AI admin and every other login see the card with the switches GREYED and the reason
 * printed. State lives in the one owner-settings route (PUT /owner-settings/hubAutoSend).
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useIsKyle, useSession, useSessionFailed } from "../lib/session";
import { whenText } from "../lib/hubLabels";
import { AUTO_SEND_CATEGORIES } from "../../../shared/hub/autoSendCategories";

export const AUTOSEND_LOCK_REASON = "Only Kyle's PIN sign-in can change these.";
export const AUTOSEND_SUBTITLE = "Off means an AI's customer messages and Training replies wait for someone to press Approve. Nothing here sends while Agent access is not On. AI posts in the Team, group and job crew chats are set per key on Settings → Agent keys (\"Team posts publish immediately\").";
export const AUTOSEND_TURN_ON_QUESTION = "Messages in this category will go out without anyone pressing Approve. Turn on?";
export const AUTOSEND_GATE_ENV = "AUTOMATED_CUSTOMER_SENDS_HUB_AUTOSEND";
export const AUTOSEND_GATE_NOTE = `Also needs ${AUTOSEND_GATE_ENV}=on in Railway — none of these rules sends anything until then.`;

const QUERY_KEY = ["hubAutoSend"] as const;

export function AutoSendRulesSection() {
  const queryClient = useQueryClient();
  const session = useSession();
  const sessionFailed = useSessionFailed();
  const isKyle = useIsKyle();
  const allowed = isKyle && session?.kind !== "ai-admin";
  const ready = allowed && (session !== null || sessionFailed);

  const { data, error: loadError } = useQuery({ queryKey: QUERY_KEY, queryFn: () => api.hubAutoSend(), enabled: ready, retry: false });
  const known = data !== undefined;
  const loadFailed = loadError !== null && loadError !== undefined;
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const categories = data?.value.categories ?? {};
  const unknownReason: string | null = !allowed ? AUTOSEND_LOCK_REASON : known ? null : loadFailed ? "AI auto-send rules could not be loaded." : "Loading…";

  async function set(key: string, label: string, on: boolean) {
    if (on && !window.confirm(AUTOSEND_TURN_ON_QUESTION)) return;
    setBusy(key);
    setError(null);
    try {
      const saved = await api.saveHubAutoSend({ ...categories, [key]: on });
      queryClient.setQueryData(QUERY_KEY, saved);
      setNotice(`${label} auto-send turned ${on ? "on" : "off"}.`);
    } catch (e) {
      setNotice(null);
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="card mt-5 p-6" aria-label="AI auto-send rules">
      <h2 className="text-lg font-semibold">AI auto-send rules</h2>
      <p className="mt-1 text-sm text-rce-muted">{AUTOSEND_SUBTITLE}</p>

      {!allowed && (
        <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900" data-testid="autosend-locked">{AUTOSEND_LOCK_REASON}</p>
      )}
      {allowed && known && data.status && !data.status.gateOn && (
        <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900" data-testid="autosend-gate-note">{AUTOSEND_GATE_NOTE}</p>
      )}
      {notice && <p className="mt-3 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-900">{notice}</p>}
      {error && <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">{error}</p>}

      <div className="mt-4 grid gap-3">
        {AUTO_SEND_CATEGORIES.map((c) => {
          const on = categories[c.key] === true;
          // Without the saved state (not Kyle, still loading, or it failed) the switch's position is UNKNOWN: say
          // so, never "Off" - Kyle may have turned it on.
          const unknown = !known;
          return (
            <div key={c.key} className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-rce-border p-3" data-testid={`autosend-${c.key}`}>
              <div className="min-w-0">
                <p className="font-semibold">{c.label}</p>
                <p className="text-xs text-rce-muted">
                  Sends on its own only if it is {c.lengthCap} characters or fewer{c.allowsPrices ? "" : " and names no dollar amount"}, and the customer may be contacted that way.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span className={`rounded px-1.5 py-0.5 text-xs font-semibold ${unknown ? "bg-gray-100 text-gray-600" : on ? "bg-green-100 text-green-900" : "bg-gray-200 text-gray-800"}`}>
                  {unknown ? (allowed ? "…" : "Not shown") : on ? "On" : "Off"}
                </span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={on}
                  aria-label={`Auto-send ${c.label}`}
                  className="btn btn-secondary"
                  disabled={busy !== null || unknownReason !== null}
                  title={unknownReason ?? (on ? "Turn this off: these messages wait for Approve again" : "Let these messages go out without Approve")}
                  onClick={() => void set(c.key, c.label, !on)}
                >
                  {unknown ? "Turn on or off" : on ? "Turn off" : "Turn on"}
                </button>
              </div>
            </div>
          );
        })}
        {AUTO_SEND_CATEGORIES.length === 0 && <p className="text-sm text-rce-muted">No kind of message can be sent automatically.</p>}
      </div>
      {allowed && known && data.value.changedAt && (
        <p className="mt-3 text-xs text-rce-muted">Last changed {whenText(data.value.changedAt)}{data.value.changedBy ? ` by ${data.value.changedBy}` : ""}.</p>
      )}
    </section>
  );
}
