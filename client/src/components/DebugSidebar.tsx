/**
 * The debug sidebar — the inspect console, on the device, wired to the coding agent. (P032)
 *
 * Kyle asked for a sidebar that "connects to the inspect consol so you can debug and correct
 * things real time", and then for the half that was still missing: *"I need a way to show you
 * specifically what needs changed."*
 *
 * So it does two jobs.
 *
 *   **Console.** `lib/debugBus.ts` captures errors, warnings and the network trace and ships them
 *   to `SystemEvent`, where I read them. Errors go on their own; everything else goes when he
 *   presses Send.
 *
 *   **Pointing.** `lib/elementPicker.ts` lets him tap the control he means and attach an
 *   instruction to it. Because the build stamps every element with `data-rce-src`, what reaches
 *   me is `src/pages/PriceBookIntakePage.tsx:412` and his words — a file and a line instead of a
 *   description I have to translate.
 *
 * It replaces `FeedbackWidget` and keeps everything that widget did, with the note now travelling
 * WITH the evidence rather than alone.
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
import { DEBUG_UI_ATTR, startPicking, type PickedElement } from "../lib/elementPicker";

type Filter = "all" | "problems" | "network";

const KIND_STYLE: Record<DebugKind, string> = {
  error: "text-red-300",
  warn: "text-amber-300",
  network: "text-sky-300",
  note: "text-emerald-300",
  pick: "text-fuchsia-300",
  nav: "text-violet-300",
  log: "text-slate-400",
};

function matches(entry: DebugEntry, filter: Filter): boolean {
  if (filter === "all") return true;
  if (filter === "problems") {
    return entry.kind === "error" || entry.kind === "warn" || entry.kind === "pick";
  }
  return entry.kind === "network";
}

export function DebugSidebar() {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<DebugEntry[]>(getEntries);
  const [filter, setFilter] = useState<Filter>("problems");
  const [note, setNote] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [expanded, setExpanded] = useState<number | null>(null);
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<PickedElement | null>(null);
  const [change, setChange] = useState("");
  const location = useLocation();
  const feedRef = useRef<HTMLDivElement>(null);
  const stopPickRef = useRef<(() => void) | null>(null);

  useEffect(() => subscribe(setEntries), []);

  // Every route change is a line in the transcript. Half of diagnosing a report is knowing what
  // screen he was on when it happened, and asking is a round trip.
  useEffect(() => {
    record("nav", `→ ${location.pathname}${location.search}`);
  }, [location.pathname, location.search]);

  // Picking must not survive the component — a stuck crosshair that swallows every click would
  // make the app unusable with no obvious way out.
  useEffect(() => () => stopPickRef.current?.(), []);

  const shown = useMemo(() => entries.filter((e) => matches(e, filter)), [entries, filter]);
  const problemCount = useMemo(
    () => entries.filter((e) => e.kind === "error" || e.kind === "warn").length,
    [entries],
  );
  const pickCount = useMemo(() => entries.filter((e) => e.kind === "pick").length, [entries]);

  useEffect(() => {
    if (open && feedRef.current) feedRef.current.scrollTop = feedRef.current.scrollHeight;
  }, [shown.length, open]);

  const beginPick = () => {
    setPicked(null);
    setChange("");
    setPicking(true);
    // Get out of the way — he cannot tap what the panel is covering.
    setOpen(false);
    stopPickRef.current = startPicking(
      (el) => {
        stopPickRef.current = null;
        setPicking(false);
        setPicked(el);
        setOpen(true);
      },
      () => {
        stopPickRef.current = null;
        setPicking(false);
        setOpen(true);
      },
    );
  };

  const cancelPick = () => {
    stopPickRef.current?.();
    stopPickRef.current = null;
    setPicking(false);
    setOpen(true);
  };

  const attachPick = () => {
    if (!picked) return;
    const where = picked.src ?? "unknown source";
    const what = picked.text || picked.label || `<${picked.tag}>`;
    record("pick", `${change.trim() || "(no instruction given)"} — on "${what}" [${where}]`, {
      changeRequested: change.trim() || null,
      source: picked.src,
      element: `<${picked.tag}>`,
      text: picked.text,
      label: picked.label,
      classes: picked.className,
      domPath: picked.path,
      onScreen: picked.rect,
      page: location.pathname,
    });
    setPicked(null);
    setChange("");
  };

  const send = async () => {
    if (state === "sending") return;
    setState("sending");
    if (note.trim()) record("note", note.trim());
    const ok = await ship({
      message: note.trim() || (pickCount > 0
        ? `${pickCount} change request(s) from ${location.pathname}`
        : `Console snapshot from ${location.pathname}`),
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

  // ── Picking: the panel is hidden and a banner explains how to get out ──────────────────────
  if (picking) {
    return (
      <div
        {...{ [DEBUG_UI_ATTR]: "" }}
        className="fixed inset-x-0 top-0 z-[2147483647] flex items-center justify-between bg-sky-600 px-4 py-3 text-white shadow-lg"
      >
        <span className="text-sm font-semibold">Tap the thing you want changed</span>
        <button className="rounded border border-white/50 px-3 py-1 text-xs" onClick={cancelPick}>
          Cancel
        </button>
      </div>
    );
  }

  return (
    <div {...{ [DEBUG_UI_ATTR]: "" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        title="Debug console"
        className="fixed bottom-20 right-4 z-40 flex h-11 w-11 items-center justify-center rounded-full bg-rce-accent text-lg text-white shadow-card md:bottom-4"
      >
        {open ? "×" : "⚡"}
        {!open && problemCount + pickCount > 0 && (
          <span className="absolute -right-1 -top-1 inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-bold text-white">
            {problemCount + pickCount > 99 ? "99+" : problemCount + pickCount}
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

          <button
            onClick={beginPick}
            className="m-2 rounded-lg bg-sky-600 py-2.5 text-sm font-semibold text-white"
          >
            ⌖ Point at something to change
          </button>

          {/* The picked element, waiting for an instruction. */}
          {picked && (
            <div className="mx-2 mb-2 rounded-lg border border-fuchsia-500/50 bg-slate-800 p-2">
              <p className="text-xs font-semibold text-fuchsia-300">
                {picked.text || picked.label || `<${picked.tag}>`}
              </p>
              <p className="mt-0.5 break-all font-mono text-[10px] text-slate-400">
                {picked.src ?? "no source stamp — reload the page to pick up the newest build"}
              </p>
              <textarea
                value={change}
                onChange={(e) => setChange(e.target.value)}
                rows={2}
                autoFocus
                placeholder="What should this do or look like instead?"
                className="mt-1.5 w-full rounded border border-slate-600 bg-slate-900 p-2 text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-fuchsia-400"
              />
              <div className="mt-1.5 flex gap-2">
                <button
                  onClick={attachPick}
                  className="flex-1 rounded bg-fuchsia-600 py-1.5 text-xs font-medium text-white"
                >
                  Add to report
                </button>
                <button
                  onClick={() => setPicked(null)}
                  className="rounded border border-slate-600 px-3 py-1.5 text-xs text-slate-300"
                >
                  Discard
                </button>
              </div>
            </div>
          )}

          <div className="flex items-center gap-1 border-b border-t border-slate-700 px-2 py-1.5">
            {(["problems", "network", "all"] as Filter[]).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={`rounded px-2 py-1 text-xs capitalize ${
                  filter === f ? "bg-rce-accent text-white" : "text-slate-400"
                }`}
              >
                {f}
                {f === "problems" && problemCount + pickCount > 0
                  ? ` (${problemCount + pickCount})`
                  : ""}
              </button>
            ))}
            <button onClick={clearEntries} className="ml-auto rounded px-2 py-1 text-xs text-slate-400">
              Clear
            </button>
          </div>

          <div
            ref={feedRef}
            className="min-h-0 flex-1 overflow-y-auto px-2 py-1 font-mono text-[11px] leading-snug"
          >
            {shown.length === 0 && (
              <p className="p-4 text-center text-slate-500">
                Nothing yet. Point at something you want changed, or reproduce a problem with this
                open, then press Send.
              </p>
            )}
            {shown.map((e) => (
              <div key={e.id} className="border-b border-slate-800 py-1">
                <button
                  className="flex w-full items-start gap-2 text-left"
                  onClick={() => setExpanded(expanded === e.id ? null : e.id)}
                >
                  <span className="shrink-0 text-slate-600">{e.at.slice(11, 19)}</span>
                  <span className={`whitespace-pre-wrap break-words ${KIND_STYLE[e.kind]}`}>
                    {e.text}
                  </span>
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
              placeholder="Anything else? (optional — the console and your change requests are sent either way)"
              className="w-full rounded border border-slate-600 bg-slate-800 p-2 text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:ring-1 focus:ring-rce-accent"
            />
            <div className="mt-1.5 flex items-center justify-between gap-2">
              <span className="text-[11px] text-slate-400">
                {state === "sent" && "Sent — it's in the log."}
                {state === "error" && "Couldn't send. Check the connection."}
                {state === "sending" && "Sending…"}
                {state === "idle" &&
                  `${entries.length} line(s)${pickCount > 0 ? `, ${pickCount} change request(s)` : ""}`}
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
    </div>
  );
}
