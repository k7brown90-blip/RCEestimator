/**
 * The Message audit log (work order agent-team, U4; Kyle only): a read-only list of what the hub did -
 * drafts approved, edited, rejected, sent, held and refused - newest first. Click path from the
 * Dashboard: Settings -> "Message audit log"; for one conversation, the "Audit" button in that Thread
 * drawer's header.
 *
 *   Show: "All activity" | "Blocked texts"   Blocked texts is every text the CRM refused to send: when,
 *         why, its class and its send type, and the conversation. Never a phone number, never the words.
 *   Who:  every person, agent or rule that acted.
 *
 * Read-only on purpose: the log is append-only and has no edit or delete, so there is nothing to hide
 * here. Another login, and the AI admin, see the card greyed with the reason.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useDrawerParams } from "../lib/drawers";
import { useIsKyle, useSession, useSessionFailed } from "../lib/session";
import { whenText } from "../lib/hubLabels";
import type { AuditEntryView } from "../../../shared/hub/views";

export const AUDIT_LOCK_REASON = "Only Kyle can read the message audit log.";

/**
 * `firstRows` shows only that many rows at first (Settings: 20); "Show older" then reveals the rest of the rows already loaded and only
 * after that asks the server for more. Without it (the Thread drawer) every loaded row shows, exactly as before.
 */
export function MessageAuditLog({ threadId, firstRows }: { threadId?: string; firstRows?: number }) {
  const drawers = useDrawerParams();
  const session = useSession();
  const failed = useSessionFailed();
  const isKyle = useIsKyle();
  const allowed = isKyle && session?.kind !== "ai-admin";
  const ready = allowed && (session !== null || failed);

  const [show, setShow] = useState<"all" | "send_blocked">("all");
  const [actor, setActor] = useState("");
  const [older, setOlder] = useState<AuditEntryView[]>([]);
  const [olderMore, setOlderMore] = useState<boolean | null>(null);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState<string | null>(null);
  const [visible, setVisible] = useState<number>(firstRows ?? Number.POSITIVE_INFINITY);

  const filter = { threadId, actor: actor || undefined, action: show === "send_blocked" ? "send_blocked" : undefined };
  const { data, isLoading, error } = useQuery({
    queryKey: ["hub-audit", { threadId: threadId ?? null, actor: actor || null, action: filter.action ?? null }],
    queryFn: () => api.hubAudit(filter),
    enabled: ready,
    retry: false,
  });

  const loaded = [...(data?.entries ?? []), ...older];
  const entries = loaded.slice(0, visible);
  const hiddenLoaded = loaded.length - entries.length;
  const more = olderMore ?? data?.more ?? false;
  const reset = () => { setOlder([]); setOlderMore(null); setOlderError(null); setVisible(firstRows ?? Number.POSITIVE_INFINITY); };

  async function loadOlder() {
    // First the rows already loaded but not shown; only when all of them are on screen, the next page from the server.
    if (hiddenLoaded > 0) { setVisible(Number.POSITIVE_INFINITY); return; }
    const last = entries[entries.length - 1];
    if (!last) return;
    setLoadingOlder(true);
    setOlderError(null);
    try {
      const page = await api.hubAudit({ ...filter, before: last.at });
      setOlder((o) => [...o, ...page.entries]);
      setOlderMore(page.more);
    } catch (e) {
      setOlderError((e as Error).message);
    } finally {
      setLoadingOlder(false);
    }
  }

  return (
    <div aria-label="Message audit log" className="space-y-3">
      {!allowed && <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900" data-testid="audit-locked">{AUDIT_LOCK_REASON}</p>}

      <div className="flex flex-wrap items-end gap-3">
        <label className="block text-xs font-medium text-rce-soft">
          Show
          <select className="field mt-1" value={show} disabled={!allowed} onChange={(e) => { setShow(e.target.value as "all" | "send_blocked"); reset(); }}>
            <option value="all">All activity</option>
            <option value="send_blocked">Blocked texts</option>
          </select>
        </label>
        <label className="block text-xs font-medium text-rce-soft">
          Who
          <select className="field mt-1" value={actor} disabled={!allowed} onChange={(e) => { setActor(e.target.value); reset(); }}>
            <option value="">Everyone</option>
            {(data?.actors ?? []).map((a) => <option key={a.key} value={a.key}>{a.display}</option>)}
          </select>
        </label>
      </div>

      {error && <p className="text-sm text-red-600">Could not load the audit log: {(error as Error).message}</p>}
      {allowed && isLoading && <p className="text-sm text-rce-muted">Loading…</p>}

      <ul className="space-y-1.5">
        {entries.map((e) => (
          <li key={e.id} className="rounded border border-rce-border px-3 py-1.5 text-xs" data-audit-id={e.id}>
            <p className="flex flex-wrap items-center gap-x-2">
              <span className="text-rce-muted">{whenText(e.at)}</span>
              <span className={`rounded px-1.5 py-0.5 font-semibold ${e.action === "send_blocked" ? "bg-red-100 text-red-800" : "bg-gray-100 text-gray-700"}`}>{e.actionLabel}</span>
              <span className="text-rce-soft">{e.actorDisplay}</span>
            </p>
            <p className="mt-0.5">{e.summary}</p>
            {e.reason && <p className="mt-0.5 font-medium text-red-700">{e.reason}</p>}
            {e.threadId && !threadId && (
              <button type="button" className="mt-0.5 underline text-rce-muted" onClick={() => drawers.open("thread", e.threadId as string)}>Open the conversation</button>
            )}
          </li>
        ))}
        {allowed && !isLoading && !error && entries.length === 0 && (
          <li className="text-sm text-rce-muted">{show === "send_blocked" ? "No text has been blocked." : "Nothing has been recorded yet."}</li>
        )}
      </ul>
      {olderError && <p className="text-xs text-red-600">{olderError}</p>}
      {(hiddenLoaded > 0 || more) && (
        <button type="button" className="btn btn-secondary text-xs" onClick={() => void loadOlder()} disabled={loadingOlder}>
          {loadingOlder ? "Loading…" : "Show older"}
        </button>
      )}
    </div>
  );
}
