/**
 * Settings -> "Agent events" (work order agent-team, BA5). The log of every signed event the CRM has
 * sent, or kept, for the AI agents (an estimate was opened or signed, a payment came in, a lead
 * arrived, a job was completed, material was used, a team message was posted), and the Resend button.
 *
 * Click path from the Dashboard: left nav "Settings" -> scroll to "Agent events", directly under
 * "Agent keys" (two clicks).
 *
 *   * Filter chips: All / Delivered / Retrying / Dead / No URL, and an Event-type dropdown.
 *   * Each row shows the time, the event type, a one-line summary, the status, the number of attempts
 *     and the last error, with "Show attempts" (the attempt history) and "Resend".
 *   * A banner says when no receiving address is set (events are KEPT, and Resend delivers them once
 *     it is) and when HUB_WEBHOOK_SECRET is not set (nothing is sent until it is).
 *   * "Resend" is on every row. On a Delivered row it is greyed with its reason (the agents drop a
 *     repeat of the same event, so it would do nothing); on Dead, Retrying and No URL rows it is live.
 *
 * Controls are GREYED with their reason, never hidden: a session without the bot_keys power (and the
 * AI admin) sees the card with every control greyed and the reason printed. The log holds only the
 * templated summary of each event: no name, link, phone, email or address, and never the secret or
 * the receiving address.
 */
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useCan, useSession, useSessionFailed } from "../lib/session";
import type { HubEventView } from "../lib/types";
import { AGENT_KEYS_AI_ADMIN_REASON } from "../../../shared/agentScopes";
import { HUB_EVENT_LABELS, HUB_EVENT_TYPES, RESEND_DELIVERED_REASON, type HubEventType } from "../../../shared/hub/events";

const CHIPS: Array<{ id: string; label: string }> = [
  { id: "all", label: "All" },
  { id: "delivered", label: "Delivered" },
  { id: "retrying", label: "Retrying" },
  { id: "dead", label: "Dead" },
  { id: "no_target", label: "No URL" },
];

export const NO_URL_BANNER = "No receiving address is set (HUB_AGENT_WEBHOOK_URL in Railway). Events are being kept — press Resend once it is set.";
export const NO_SECRET_BANNER = "HUB_WEBHOOK_SECRET is not set — nothing is sent until it is.";

const STATUS_TEXT: Record<string, string> = {
  pending: "Waiting to send",
  retrying: "Retrying",
  delivered: "Delivered",
  dead: "Dead — gave up",
  no_target: "No URL — kept",
};
const STATUS_TONE: Record<string, string> = {
  pending: "bg-blue-100 text-blue-900",
  retrying: "bg-amber-100 text-amber-900",
  delivered: "bg-green-100 text-green-900",
  dead: "bg-red-100 text-red-900",
  no_target: "bg-gray-200 text-gray-800",
};

const whenText = (iso: string | null): string =>
  iso
    ? new Date(iso).toLocaleString("en-US", { timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
    : "";

const typeLabel = (type: string): string => HUB_EVENT_LABELS[type as HubEventType] ?? type;

export function AgentEventsSection() {
  const queryClient = useQueryClient();
  const session = useSession();
  const sessionFailed = useSessionFailed();
  const can = useCan("bot_keys");
  const isAiAdmin = session?.kind === "ai-admin";
  const allowed = can.allowed && !isAiAdmin;
  const lockReason: string | null = isAiAdmin ? AGENT_KEYS_AI_ADMIN_REASON : can.reason;
  const ready = allowed && (session !== null || sessionFailed);

  const [status, setStatus] = useState("all");
  const [type, setType] = useState("");
  const [older, setOlder] = useState<HubEventView[]>([]);
  const [olderCursor, setOlderCursor] = useState<string | null | undefined>(undefined);
  const [open, setOpen] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const key = ["hubEvents", status, type] as const;
  const { data, error: loadError } = useQuery({ queryKey: key, queryFn: () => api.hubEvents({ status, type }), enabled: ready });
  const { data: config } = useQuery({ queryKey: ["hubEventsConfig"], queryFn: () => api.hubEventsConfig(), enabled: ready });

  // A different filter starts a new list.
  useEffect(() => {
    setOlder([]);
    setOlderCursor(undefined);
    setOpen(null);
  }, [status, type]);

  const events = [...(data?.events ?? []), ...older];
  const nextBefore = olderCursor === undefined ? data?.nextBefore ?? null : olderCursor;
  const known = data !== undefined;
  const loadFailed = loadError !== null && loadError !== undefined;

  async function loadOlder() {
    if (!nextBefore) return;
    setError(null);
    try {
      const page = await api.hubEvents({ status, type, before: nextBefore });
      setOlder((prev) => [...prev, ...page.events]);
      setOlderCursor(page.nextBefore);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function resend(ev: HubEventView) {
    setBusy(ev.id);
    setError(null);
    setNotice(null);
    try {
      const { event } = await api.resendHubEvent(ev.id);
      // The server's own reason, so the notice sends Kyle after the real fix (no secret, agent Off, no
      // address, a refusing receiver, a 5xx) instead of a guess from the status alone.
      setNotice(
        event.status === "delivered" ? "Delivered."
          : event.lastError ? `Not delivered — ${event.lastError}.`
            : "Sent again; it will retry if the receiver is down.",
      );
      setOlder([]);
      setOlderCursor(undefined);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["hubEvents"] }),
        queryClient.invalidateQueries({ queryKey: ["hubEventsConfig"] }),
      ]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const resendReason = (ev: HubEventView): string | null => {
    if (!allowed) return lockReason;
    if (ev.status === "delivered") return RESEND_DELIVERED_REASON;
    return null;
  };

  return (
    <section className="card mt-5 p-6" aria-label="Agent events">
      <h2 className="text-lg font-semibold">Agent events</h2>
      <p className="mt-1 text-sm text-rce-muted">
        Every signed message the CRM sends the AI agents: an estimate opened or signed, a payment recorded, a new lead, a job completed,
        material used, a team message. Each row says only what happened and to which record, never a name or contact detail.
      </p>

      {!allowed && lockReason && (
        <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900" data-testid="agent-events-locked">
          {lockReason}
        </p>
      )}
      {allowed && config && !config.urlSet && (
        <p className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="agent-events-no-url">{NO_URL_BANNER}</p>
      )}
      {allowed && config && !config.secretSet && (
        <p className="mt-3 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900" data-testid="agent-events-no-secret">{NO_SECRET_BANNER}</p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {CHIPS.map((c) => (
          <button
            key={c.id}
            type="button"
            className={`btn ${status === c.id ? "btn-primary" : "btn-secondary"}`}
            aria-pressed={status === c.id}
            disabled={!allowed}
            title={!allowed ? lockReason ?? undefined : undefined}
            onClick={() => setStatus(c.id)}
          >
            {c.label}
          </button>
        ))}
        <label className="ml-auto flex items-center gap-2 text-sm">
          Event type
          <select
            className="field"
            value={type}
            disabled={!allowed}
            title={!allowed ? lockReason ?? undefined : undefined}
            onChange={(e) => setType(e.target.value)}
            aria-label="Event type"
          >
            <option value="">All types</option>
            {HUB_EVENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </label>
      </div>

      {notice && <p className="mt-3 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-900">{notice}</p>}
      {error && <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">{error}</p>}
      {loadFailed && allowed && (
        <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800" data-testid="agent-events-load-error">
          Couldn't load agent events — {(loadError as Error).message}
        </p>
      )}

      <div className="mt-4 overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-rce-border text-xs uppercase tracking-wide text-rce-muted">
              <th className="py-2 pr-3">Time</th><th className="pr-3">Event</th><th className="pr-3">What happened</th>
              <th className="pr-3">Status</th><th className="pr-3">Tries</th><th className="pr-3">Last error</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {events.length === 0 && (
              <tr>
                <td colSpan={7} className="py-3 text-rce-muted" data-testid="agent-events-empty">
                  {!allowed ? "" : loadFailed ? "Couldn't load agent events." : !known ? "Loading…" : "No events yet."}
                </td>
              </tr>
            )}
            {events.map((ev) => {
              const reason = resendReason(ev);
              return (
                <tr key={ev.id} className="border-b border-rce-border align-top" data-testid={`agent-event-${ev.id}`}>
                  <td className="py-2 pr-3 whitespace-nowrap">{whenText(ev.createdAt)}</td>
                  <td className="pr-3">
                    <div className="mono text-xs">{ev.type}</div>
                    <div className="text-xs text-rce-muted">{typeLabel(ev.type)}</div>
                  </td>
                  <td className="pr-3">{ev.summary}</td>
                  <td className="pr-3">
                    <span className={`rounded px-1.5 py-0.5 text-xs font-semibold ${STATUS_TONE[ev.status] ?? "bg-gray-200 text-gray-800"}`}>
                      {STATUS_TEXT[ev.status] ?? ev.status}
                    </span>
                    {ev.nextAttemptAt && (ev.status === "retrying" || ev.status === "pending") && (
                      <div className="text-xs text-rce-muted">Next try {whenText(ev.nextAttemptAt)}</div>
                    )}
                  </td>
                  <td className="pr-3">{ev.attempts}</td>
                  <td className="pr-3 text-xs">{ev.lastError ?? ""}</td>
                  <td>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        className="btn btn-secondary"
                        aria-expanded={open === ev.id}
                        onClick={() => setOpen(open === ev.id ? null : ev.id)}
                      >
                        {open === ev.id ? "Hide attempts" : "Show attempts"}
                      </button>
                      <button
                        type="button"
                        className="btn btn-secondary"
                        disabled={busy !== null || reason !== null}
                        title={reason ?? undefined}
                        aria-label={`Resend ${ev.type}`}
                        onClick={() => void resend(ev)}
                      >
                        Resend
                      </button>
                    </div>
                    {reason && allowed && <div className="mt-1 max-w-xs text-xs text-rce-muted" data-testid={`resend-reason-${ev.id}`}>{reason}</div>}
                    {open === ev.id && (
                      <ul className="mt-2 grid gap-1 text-xs" data-testid={`attempts-${ev.id}`}>
                        {ev.attemptLog.length === 0 && <li className="text-rce-muted">No attempts yet.</li>}
                        {ev.attemptLog.map((a, i) => (
                          <li key={`${a.at}-${i}`}>
                            {whenText(a.at)} — {a.statusCode !== null ? `HTTP ${a.statusCode}` : "no answer"}
                            {a.ms !== null ? `, ${a.ms} ms` : ""}{a.error ? ` — ${a.error}` : ""}
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {allowed && nextBefore && (
        <button type="button" className="btn btn-secondary mt-3" onClick={() => void loadOlder()}>Load older events</button>
      )}
    </section>
  );
}
