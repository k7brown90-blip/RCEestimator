/**
 * Settings -> "Agent webhooks" (work order agent-team, TC4; Kyle only). Where the signed agent events
 * are sent: the receiving address and On/Off for each agent that listens (Admin and Inventory), and a
 * table saying which agent gets which event type.
 *
 * Click path from the Dashboard: left nav "Settings" -> scroll to "Agent webhooks", under "Agent events"
 * (two clicks).
 *
 *   * Each agent row shows its name, its address (or "No address — the agent will poll"), On or Off,
 *     and "Edit address", "Turn off" / "Turn on" and "Remove address" (the exit: the row stays, the
 *     address goes, and events are kept until a new one is set).
 *   * The table below lists every event type with the agent it goes to; the dropdown re-points it.
 *     Admin's blank address falls back to HUB_AGENT_WEBHOOK_URL in Railway.
 *   * ONE secret (HUB_WEBHOOK_SECRET in Railway) signs every agent's events; there is no second secret.
 *
 * Kyle only. Every other session (a login without his rights, the AI admin) sees the card with every
 * control GREYED and the reason printed, never hidden. All writes go through the one owner-settings
 * route (PUT /owner-settings/agentWebhooks).
 */
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useIsKyle, useSession, useSessionFailed } from "../lib/session";
import type { AgentWebhooksValue } from "../lib/types";
import {
  DEFAULT_EVENT_ROUTES, HUB_EVENT_LABELS, HUB_EVENT_TYPES, HUB_WEBHOOK_TARGET_IDS, HUB_WEBHOOK_TARGET_LABELS,
  type HubEventType, type HubWebhookTargetId,
} from "../../../shared/hub/events";

export const WEBHOOKS_LOCK_REASON = "Only Kyle can see or change where agent events go.";
export const NO_ADDRESS_TEXT = "No address — the agent will poll";
export const ENV_ADDRESS_TEXT = "Using HUB_AGENT_WEBHOOK_URL from Railway";
export const ENV_REFUSED_TEXT = "HUB_AGENT_WEBHOOK_URL in Railway is not an allowed https address, so it is ignored — the agent will poll";
export const ENV_REMOVE_REASON = "This address comes from HUB_AGENT_WEBHOOK_URL in Railway — remove it there, or press Turn off to stop sending.";

const EMPTY: AgentWebhooksValue = {
  targets: HUB_WEBHOOK_TARGET_IDS.map((id) => ({ id, url: null, enabled: true })),
  routes: {},
};

const QUERY_KEY = ["agentWebhooks"] as const;

export function AgentWebhooksSection() {
  const queryClient = useQueryClient();
  const session = useSession();
  const sessionFailed = useSessionFailed();
  const isKyle = useIsKyle();
  const allowed = isKyle && session?.kind !== "ai-admin";
  const ready = allowed && (session !== null || sessionFailed);

  const { data, error: loadError } = useQuery({ queryKey: QUERY_KEY, queryFn: () => api.agentWebhooks(), enabled: ready });
  const { data: config } = useQuery({ queryKey: ["hubEventsConfig"], queryFn: () => api.hubEventsConfig(), enabled: ready });
  const value: AgentWebhooksValue = data?.value ?? EMPTY;
  const known = data !== undefined;
  const loadFailed = loadError !== null && loadError !== undefined;

  const [editing, setEditing] = useState<HubWebhookTargetId | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const targetOf = (id: HubWebhookTargetId) => value.targets.find((t) => t.id === id) ?? { id, url: null, enabled: true };
  const unknownReason: string | null = !allowed ? WEBHOOKS_LOCK_REASON : known ? null : loadFailed ? "Agent webhooks could not be loaded." : "Loading…";

  async function save(next: AgentWebhooksValue, success: string): Promise<boolean> {
    setBusy(true);
    setError(null);
    try {
      const saved = await api.saveAgentWebhooks(next);
      queryClient.setQueryData(QUERY_KEY, saved);
      await queryClient.invalidateQueries({ queryKey: ["hubEventsConfig"] });
      setNotice(success);
      return true;
    } catch (e) {
      setNotice(null);
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  const withTarget = (id: HubWebhookTargetId, patch: { url?: string | null; enabled?: boolean }): AgentWebhooksValue => ({
    ...value,
    targets: HUB_WEBHOOK_TARGET_IDS.map((tid) => (tid === id ? { ...targetOf(tid), ...patch } : targetOf(tid))),
  });

  async function saveAddress(id: HubWebhookTargetId) {
    const url = draft.trim() === "" ? null : draft.trim();
    if (await save(withTarget(id, { url }), url ? `${HUB_WEBHOOK_TARGET_LABELS[id]} address saved.` : `${HUB_WEBHOOK_TARGET_LABELS[id]} address removed.`)) setEditing(null);
  }

  async function setRoute(type: HubEventType, target: HubWebhookTargetId) {
    const routes = { ...value.routes };
    if (target === DEFAULT_EVENT_ROUTES[type]) delete routes[type];
    else routes[type] = target;
    await save({ ...value, routes }, `${type} now goes to ${HUB_WEBHOOK_TARGET_LABELS[target]}.`);
  }

  return (
    <section className="card mt-5 p-6" aria-label="Agent webhooks">
      <h2 className="text-lg font-semibold">Agent webhooks</h2>
      <p className="mt-1 text-sm text-rce-muted">
        Where the signed agent events are sent. Each agent that listens has its own receiving address; one secret (HUB_WEBHOOK_SECRET in Railway)
        signs them all. With no address an event is kept in Agent events and the agent polls instead. Admin uses
        HUB_AGENT_WEBHOOK_URL from Railway when no address is saved here.
      </p>

      {!allowed && (
        <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900" data-testid="agent-webhooks-locked">
          {WEBHOOKS_LOCK_REASON}
        </p>
      )}
      {notice && <p className="mt-3 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-900">{notice}</p>}
      {error && <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">{error}</p>}

      <div className="mt-4 grid gap-3">
        {HUB_WEBHOOK_TARGET_IDS.map((id) => {
          const t = targetOf(id);
          const isEditing = editing === id;
          const adminEnv = id === "admin" && config?.adminEnvUrlSet === true;
          const adminEnvRefused = id === "admin" && config?.adminEnvUrlRefused === true;
          // Admin with no saved address is sending to the Railway variable when it is set: say so, and
          // keep "Remove address" greyed (there is nothing saved here to remove) with the reason.
          const fromRailway = t.url === null && adminEnv;
          const addressText = t.url ?? (adminEnv ? ENV_ADDRESS_TEXT : adminEnvRefused ? ENV_REFUSED_TEXT : NO_ADDRESS_TEXT);
          return (
            <div key={id} className="rounded-md border border-rce-border p-3" data-testid={`webhook-target-${id}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{HUB_WEBHOOK_TARGET_LABELS[id]}</span>
                <span className={`rounded px-1.5 py-0.5 text-xs font-semibold ${t.enabled ? "bg-green-100 text-green-900" : "bg-gray-200 text-gray-800"}`}>
                  {t.enabled ? "On" : "Off"}
                </span>
                {!isEditing && (
                  <span className="mono break-all text-xs" data-testid={`webhook-address-${id}`}>
                    {!allowed || !known ? "" : addressText}
                  </span>
                )}
              </div>

              {isEditing ? (
                <form
                  className="mt-2 flex flex-wrap items-center gap-2"
                  onSubmit={(e) => { e.preventDefault(); if (!busy) void saveAddress(id); }}
                >
                  <input
                    className="field w-full max-w-lg"
                    type="url"
                    placeholder="https://…"
                    aria-label={`${HUB_WEBHOOK_TARGET_LABELS[id]} receiving address`}
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    autoComplete="off"
                  />
                  <button className="btn btn-primary" type="submit" disabled={busy}>Save address</button>
                  <button className="btn btn-secondary" type="button" onClick={() => setEditing(null)}>Cancel</button>
                </form>
              ) : (
                <div className="mt-2 flex flex-wrap gap-2">
                  <button
                    type="button" className="btn btn-secondary" disabled={busy || unknownReason !== null} title={unknownReason ?? undefined}
                    onClick={() => { setEditing(id); setDraft(t.url ?? ""); setError(null); setNotice(null); }}
                  >
                    Edit address
                  </button>
                  <button
                    type="button" className="btn btn-secondary" disabled={busy || unknownReason !== null} title={unknownReason ?? undefined}
                    onClick={() => void save(withTarget(id, { enabled: !t.enabled }), `${HUB_WEBHOOK_TARGET_LABELS[id]} turned ${t.enabled ? "off" : "on"}.`)}
                  >
                    {t.enabled ? "Turn off" : "Turn on"}
                  </button>
                  <button
                    type="button" className="btn btn-secondary"
                    disabled={busy || unknownReason !== null || t.url === null}
                    title={unknownReason ?? (fromRailway ? ENV_REMOVE_REASON : t.url === null ? "There is no address to remove." : undefined)}
                    onClick={() => {
                      const after = adminEnv
                        ? "Admin's events will go to the Railway address (HUB_AGENT_WEBHOOK_URL) instead. Use Turn off to stop them."
                        : "Its events are kept until a new one is set.";
                      if (window.confirm(`Remove ${HUB_WEBHOOK_TARGET_LABELS[id]}'s receiving address? ${after}`)) {
                        void save(withTarget(id, { url: null }), `${HUB_WEBHOOK_TARGET_LABELS[id]} address removed.`);
                      }
                    }}
                  >
                    Remove address
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <h3 className="mt-5 text-sm font-semibold">Which agent gets which event</h3>
      <div className="mt-2 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-rce-border text-xs uppercase tracking-wide text-rce-muted">
              <th className="py-2 pr-3">Event</th><th className="pr-3">What it means</th><th>Goes to</th>
            </tr>
          </thead>
          <tbody>
            {HUB_EVENT_TYPES.map((type) => {
              const target = value.routes[type] ?? DEFAULT_EVENT_ROUTES[type];
              return (
                <tr key={type} className="border-b border-rce-border">
                  <td className="mono py-2 pr-3 text-xs">{type}</td>
                  <td className="pr-3 text-xs text-rce-muted">{HUB_EVENT_LABELS[type]}</td>
                  <td>
                    <select
                      className="field"
                      value={target}
                      disabled={busy || unknownReason !== null}
                      title={unknownReason ?? undefined}
                      aria-label={`Where ${type} goes`}
                      onChange={(e) => void setRoute(type, e.target.value as HubWebhookTargetId)}
                    >
                      {HUB_WEBHOOK_TARGET_IDS.map((id) => <option key={id} value={id}>{HUB_WEBHOOK_TARGET_LABELS[id]}</option>)}
                    </select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
