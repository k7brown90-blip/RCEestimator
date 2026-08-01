/**
 * Feedback box — the operator's direct line into the SystemEvent log.
 *
 * Whatever gets typed here lands in the same table as the backend's error
 * events (source = "feedback"), timestamped next to whatever was failing at
 * the time. The coding agent reads both streams together via
 * scripts/readSystemEvents.ts, so "the calendar page did something weird just
 * now" arrives with the correlated stack traces already adjacent.
 */

import { useState } from "react";
import { useLocation } from "react-router-dom";
import { api } from "../lib/api";

export function FeedbackWidget() {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const location = useLocation();

  const submit = async () => {
    if (!message.trim() || state === "sending") return;
    setState("sending");
    try {
      await api.sendFeedback({ message: message.trim(), page: location.pathname });
      setState("sent");
      setMessage("");
      setTimeout(() => {
        setState("idle");
        setOpen(false);
      }, 1800);
    } catch {
      setState("error");
    }
  };

  return (
    <div className="fixed bottom-20 right-4 z-40 flex flex-col items-end gap-2 md:bottom-4">
      {open && (
        <div className="w-80 rounded-xl border border-rce-border bg-rce-surface p-3 shadow-card">
          <p className="mb-2 text-sm font-semibold text-rce-text">Report a problem or idea</p>
          <textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            rows={4}
            placeholder="What happened? What were you trying to do? The current page and time are attached automatically."
            className="w-full rounded-lg border border-rce-border bg-white p-2 text-sm text-rce-text focus:outline-none focus:ring-2 focus:ring-rce-accent"
          />
          <div className="mt-2 flex items-center justify-between">
            <span className="text-xs text-rce-muted">
              {state === "sent" && "Sent — it's in the log."}
              {state === "error" && "Couldn't send. Try again."}
              {state === "sending" && "Sending…"}
            </span>
            <button
              onClick={submit}
              disabled={!message.trim() || state === "sending"}
              className="rounded-lg bg-rce-accent px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              Send
            </button>
          </div>
        </div>
      )}
      <button
        onClick={() => setOpen((v) => !v)}
        title="Report a problem"
        className="flex h-11 w-11 items-center justify-center rounded-full bg-rce-accent text-lg text-white shadow-card"
      >
        {open ? "×" : "?"}
      </button>
    </div>
  );
}
