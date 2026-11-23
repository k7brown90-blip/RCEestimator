/**
 * Settings -> "Message reminders" (work order agent-team, U8, Kyle only): when a draft is waiting for approval,
 * the approvers get ONE reminder after 15 minutes and then at most one an hour, Monday to Friday, inside the
 * hours set here (America/Chicago). A decided draft is never reminded about.
 *
 * Click path from the Dashboard: left nav "Settings" -> scroll to "Message reminders", under "AI auto-send
 * rules" (two clicks). The reminder is a notification on the person's device: "Messages" -> "Turn on
 * notifications on this device" turns that on (the card says so).
 *
 *   * Only the hours are set here. Mon-Fri is fixed text, not a field (it is Kyle's reminder rule only: customer
 *     texts go out all seven days since 2026-11-22), so there is no control that could silently do nothing.
 *   * "Save hours" keeps the two times; "Use 8:00 AM - 8:00 PM" puts the default back. Both are the exit.
 *   * Kyle only. The AI admin and every other login see the card with the boxes GREYED and the reason printed.
 *     State lives in the one owner-settings route (PUT /owner-settings/hubNotify).
 */
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useIsKyle, useSession, useSessionFailed } from "../lib/session";

export const REMINDERS_LOCK_REASON = "Only Kyle's PIN sign-in can change these.";
export const REMINDERS_TEXT = "Remind me about a waiting approval once after 15 minutes, then once an hour, Mon–Fri";
export const REMINDERS_DEVICE_NOTE = "Reminders arrive as notifications: on each device, open Messages and press “Turn on notifications on this device”.";
const DEFAULT_START = "08:00";
const DEFAULT_END = "20:00";

/** "08:00" -> "8:00 AM", "20:00" -> "8:00 PM". */
export function clockLabel(value: string): string {
  const [h, m] = value.split(":").map(Number);
  if (h === undefined || m === undefined || Number.isNaN(h) || Number.isNaN(m)) return value;
  const suffix = h >= 12 ? "PM" : "AM";
  return `${h % 12 === 0 ? 12 : h % 12}:${String(m).padStart(2, "0")} ${suffix}`;
}

const QUERY_KEY = ["hubNotify"] as const;

export function MessageRemindersSection() {
  const queryClient = useQueryClient();
  const session = useSession();
  const sessionFailed = useSessionFailed();
  const isKyle = useIsKyle();
  const allowed = isKyle && session?.kind !== "ai-admin";
  const ready = allowed && (session !== null || sessionFailed);

  const { data, error: loadError } = useQuery({ queryKey: QUERY_KEY, queryFn: () => api.hubNotify(), enabled: ready, retry: false });
  const known = data !== undefined;
  const loadFailed = loadError !== null && loadError !== undefined;
  const [start, setStart] = useState(DEFAULT_START);
  const [end, setEnd] = useState(DEFAULT_END);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (data) { setStart(data.value.start); setEnd(data.value.end); }
  }, [data]);

  const unknownReason: string | null = !allowed ? REMINDERS_LOCK_REASON : known ? null : loadFailed ? "The reminder hours could not be loaded." : "Loading…";
  const orderBlock = start >= end ? "The start time must be earlier than the end time." : null;
  const unchanged = known && data.value.start === start && data.value.end === end;

  async function save(value: { start: string; end: string }) {
    setBusy(true);
    setError(null);
    try {
      const saved = await api.saveHubNotify(value);
      queryClient.setQueryData(QUERY_KEY, saved);
      setNotice(`Reminders will go out ${clockLabel(saved.value.start)} – ${clockLabel(saved.value.end)}, Mon–Fri.`);
    } catch (e) {
      setNotice(null);
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card mt-5 p-6" aria-label="Message reminders">
      <h2 className="text-lg font-semibold">Message reminders</h2>
      <p className="mt-1 text-sm text-rce-muted">
        {REMINDERS_TEXT} {clockLabel(known ? data.value.start : start)} – {clockLabel(known ? data.value.end : end)}.
      </p>
      <p className="mt-1 text-xs text-rce-muted">{REMINDERS_DEVICE_NOTE}</p>

      {!allowed && (
        <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900" data-testid="reminders-locked">{REMINDERS_LOCK_REASON}</p>
      )}
      {notice && <p className="mt-3 rounded-md border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-900">{notice}</p>}
      {error && <p className="mt-3 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800">{error}</p>}

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <label className="block text-xs font-medium text-rce-soft">
          From
          <input
            type="time" className="field mt-1" value={start} onChange={(e) => setStart(e.target.value)}
            disabled={unknownReason !== null || busy} title={unknownReason ?? undefined}
          />
        </label>
        <label className="block text-xs font-medium text-rce-soft">
          To
          <input
            type="time" className="field mt-1" value={end} onChange={(e) => setEnd(e.target.value)}
            disabled={unknownReason !== null || busy} title={unknownReason ?? undefined}
          />
        </label>
        <button
          type="button" className="btn btn-primary"
          disabled={unknownReason !== null || busy || orderBlock !== null || unchanged}
          title={unknownReason ?? orderBlock ?? (unchanged ? "These are the hours already saved." : "Save the reminder hours")}
          onClick={() => void save({ start, end })}
        >
          {busy ? "Saving…" : "Save hours"}
        </button>
        <button
          type="button" className="btn btn-secondary"
          disabled={unknownReason !== null || busy || (known && data.value.start === DEFAULT_START && data.value.end === DEFAULT_END)}
          title={unknownReason ?? "Put the hours back to 8:00 AM – 8:00 PM"}
          onClick={() => void save({ start: DEFAULT_START, end: DEFAULT_END })}
        >
          Use 8:00 AM – 8:00 PM
        </button>
      </div>
      {unknownReason && <p className="mt-2 text-xs text-rce-muted">{unknownReason}</p>}
      {orderBlock && !unknownReason && <p className="mt-2 text-xs text-red-700">{orderBlock}</p>}
    </section>
  );
}
