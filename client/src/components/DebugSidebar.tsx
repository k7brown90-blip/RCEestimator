/**
 * The debug sidebar — the inspect console, on the device, wired to the coding agent. (P032)
 *
 * Kyle asked for a sidebar that "connects to the inspect consol so you can debug and correct
 * things real time". This is the visible half; `lib/debugBus.ts` is the capture half and carries
 * the reasoning for the split.
 *
 * It replaces `FeedbackWidget`, and keeps everything that widget did — a note box that writes to
 * `SystemEvent` — while adding the thing that was missing: **the note now travels with the
 * evidence.** "The finalized estimate is blank" arrives attached to the request that returned the
 * wrong document, instead of arriving alone and costing a round trip to reproduce.
 *
 * Two audiences, one panel:
 *
 *   * **Kyle** gets a console on a phone, where there is no devtools. He can see the red line the
 *     moment it happens instead of describing a symptom.
 *   * **I** get the same lines in `SystemEvent`, read with `scripts/tailClientLog.ts`.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useLocation } from "react-router-dom";
import {
  clearEntries,
  getEntries,
  record,
  ship,
  subscribe,
  SESSION_ID,
  type DebugEntry,
  type DebugKind,
} from "../lib/debugBus";

type Filter = "all" | "problems" | "network";

const KIND_STYLE: Record<DebugKind, string> = {
  error: "text-red-300",
  warn: "text-amber-300",
  network: "text-sky-300",
  note: "text-emerald-300",
  nav: "text-violet-300",
  log: "text-slate-400",
};

function matches(entry: DebugEntry, filter: Filter): boolean {
  if (filter === "all") return true;
  if (filter === "problems") return entry.kind === "error" || entry.kind === "warn";
  return entry.kind === "network";
}

export function DebugSidebar() {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<DebugEntry[]>(getEntries);
  const [filter, setFilter] = useState<Filter>("problems");
  const [note, setNote] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [expanded, setExpanded] = useState<number | null>(null);
  const location = useLocation();
  const feedRef = useRef<HTMLDivElement>(null);

  useEffect(() => subscribe(setEntries), []);

  // Every route change is a line in the transcript. Half of diagnosing a report is knowing what
  // screen he was on when it happened, and asking is a round trip.
  useEffect(() => {
    record("nav", `→ ${location.pathname}${location.search}`);
  }, [location.pathname, location.search]);

  const shown = useMemo(() => entries.filter((e) => matches(e, filter)), [entries, filter]);
  const problemCount = useMemo(
    () => entries.filter((e) => e.kind === "error" || e.kind === "warn").length,
    [entries],
  );

  // Pin to the newest line, the way a real console does.
  useEffect(() => {
    if (open && feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight;
  }, [shown.length, open]);

  const send = async () => {
    if (state === "sending") return;
    setState("sending");
    if (note.trim()) record("note", note.trim());
    const ok = await ship({
      // The note is the headline when there is one — it is the only line written by a human.
      message: note.trim() || `Console snapshot from ${location.pathname}`,
      note: note.trim() || undefined,
      entries: getEntries(),
    });
    if (ok) {
      setState("sent");
      setNote("");
      setTimeout(() => setState("idle"), 2500);
    } else {
      setState("error");
    }
  };

  return (
    <>
      <button
        onClick={() => setOpen((v) => !v)}
        title="Debug console"
        className="fixed bottom-20 right-4 z-40 flex h-11 w-11 items-center justify-center rounded-full bg-rce-accent text-lg text-white shadow-card md:bottom-4"
      >
        {open ? "×" : "⚡"}
        {!open && problemCount > 0 && (
          <span className="absolute -right-1 -top-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold text-white">
            {problemCount > 99 ? "99+" : problemCount}
          </span>
        )}
      </button>

      {open && (
        <aside className="fixed inset-y-0 right-0 z-50 flex w-full flex-col bg-slate-900 text-slate-100 shadow-2xl sm:w-[26rem]">
          <header className="flex items-center justify-between border-b border-slate-700 px-3 py-2">
            <div>
              <p className="text-sm font-semibold">Debug console</p>
              <p className="font-mono text-[10px] text-slate-400">
                session {SESSION_ID} · {location.pathname}
              </p>
            </div>
            <button
              onClick={() => setOpen(false)}
              className="rounded border border-slate-600 px-2 py-1 text-xs text-slate-300"
            >
              Close
            </button>
          </header>

          <div className="flex items-center gap-1 border-b border-slate-700 px-2 py-1.5">
            {(["problems", "network", "all"] as Filter[]).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`rounded px-2 py-1 text-xs capitalize ${
                  filter === f ? "bg-rce-accent text-white" : "text-slate-400"
                }`}
              >
                {f}
                {f === "problems" && problemCount > 0 ? ` (${problemCount})` : ""}
              </button>
            ))}
            <button
              onClick={clearEntries}
              className="ml-auto rounded px-2 py-1 text-xs text-slate-400"
            >
              Clear
            </button>
          </div>

          <div ref={feedRef} className="min-h-0 flex-1 overflow-y-auto px-2 py-1 font-mono text-[11px] leading-snug">
            {shown.length === 0 && (
              <p className="p-4 text-center text-slate-500">
                Nothing yet. Reproduce the problem with this open, then write what you expected and
                press Send.
              </p>
            )}
            {shown.map((e) => (
              <div key={e.id} className="border-b border-slate-800 py-1">
                <button
                  className="flex w-full items-start gap-2 text-left"
                  onClick={() => setExpanded(expanded === e.id ? null : e.id)}
                >
                  <span className="shrink-0 text-slate-600">{e.at.slice(11, 19)}</span>
                  <span className={`whitespace-pre-wrap break-words ${KIND_STYLE[e.kind]}`}>{e.text}</span>
                </button>
                {expanded === e.id && e.data && (
                  <pre className="mt-1 overflow-x-auto rounded bg-slate-950 p-2 text-[10px] text-slate-400">
                    {JSON.stringify(e.data, null, 2)}
                  </pre>
                )}
              </div>
            ))}
          </div>

          <div className="border-t border-slate-700 p-2">
            <textarea
              value={note}
              onChange={(ev) => setNote(ev.target.value)}
              rows={2}
              placeholder="What did you expect to happen? (optional — the console above is sent either way)"
              className="w-full rounded border border-slate-600 bg-slate-800 p-2 text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-rce-accent"
            />
            <div className="mt-1.5 flex items-center justify-between gap-2">
              <span className="text-[11px] text-slate-400">
                {state === "sent" && "Sent — it's in the log."}
                {state === "error" && "Couldn't send. Check the connection."}
                {state === "sending" && "Sending…"}
                {state === "idle" && `${entries.length} line(s) buffered`}
              </span>
              <button
                onClick={() => void send()}
                disabled={state === "sending"}
                className="rounded bg-rce-accent px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
              >
                Send to Claude
              </button>
            </div>
          </div>
        </aside>
      )}
    </>
  );
}
