/**
 * The debug bus — the browser's console, piped to the coding agent. (P032)
 *
 * Kyle, 2026-08-18:
 *
 *   *"What I need first is a side bar that connects directly to VS Code. Going back and forth is
 *    not working and I need a way to spot check specifics that are not working to fix real time.
 *    The side bar will connect to the inspect consol so you can debug and correct things real
 *    time."*
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────────────
 *
 * The loop we have been running is: Kyle taps something, it misbehaves, he screenshots it, I guess
 * from the pixels. Two of the last three defects were invisible in a screenshot and cost a full
 * round trip each:
 *
 *   * the blank estimate page was a CONTENT-NEGOTIATION bug — the screenshot showed white, and the
 *     only evidence was that the response was 765 bytes of SPA shell instead of the real document;
 *   * the email failure recorded `send FAILED` and nothing else, because the transport error was
 *     caught and thrown away.
 *
 * Neither was visible from outside the browser. `FeedbackWidget` already carried Kyle's WORDS to
 * `SystemEvent`; what it never carried was the EVIDENCE — the console error, the failing request,
 * the status code. So a report arrived as "it didn't work" and had to become a diagnosis by
 * inference.
 *
 * This module captures that evidence at the moment it happens and ships it to the same
 * `SystemEvent` table I already read with `scripts/readSystemEvents.ts`. That is the whole of the
 * "connects to VS Code" claim: no socket, no tunnel, no second service — his phone writes to the
 * database, and I read the database from here. It therefore works identically on the deployed
 * Railway app, which is where he actually tests, and it survives a page reload, which a devtools
 * console does not.
 *
 * ── WHAT IS AND IS NOT SENT ────────────────────────────────────────────────────────────────────
 *
 * Sent automatically: errors and warnings only, batched. Everything else — ordinary logs, the
 * successful network trace — stays in this ring buffer on his device and is transmitted ONLY when
 * he presses "Send to Claude". That split is deliberate in both directions: auto-shipping every
 * `console.log` would bury the signal in a table I read by eye, and auto-shipping nothing would
 * mean a crash he did not think to report leaves no trace.
 *
 * NEVER sent: the session token, `Authorization` headers, or request/response bodies from
 * successful calls. Bodies are captured on FAILURES only, truncated, and scrubbed. This buffer
 * holds customer names and addresses by nature — it is a CRM — so it goes to the operator's own
 * database and nowhere else.
 */

const MAX_ENTRIES = 250;
/** How many entries one report may carry. The server's own cap must not be lower. */
const MAX_SHIPPED = 240;
/**
 * Kinds that are never discarded to make room.
 *
 * 2026-08-19: Kyle sent eleven change requests and NINE arrived. The buffer was trimmed to its
 * newest 120 entries on the way out, and because a `pick` was trimmed on exactly the same terms
 * as a routine `GET … → 200`, his two earliest requests — the deliberate, typed-out ones — were
 * the first things thrown away. Twenty-six minutes of ordinary navigation outranked them.
 *
 * A pick or a note is a person choosing to say something. Context is a by-product. When room runs
 * out, the by-product goes.
 */
const NEVER_DROP: DebugKind[] = ["pick", "note"];
/** Bodies are evidence, not archives. Enough to see a validation error or a stack. */
const MAX_BODY_CHARS = 2000;
/** A render loop that logs on every frame must not turn into a write loop against the database. */
const AUTO_SHIP_MAX_PER_MINUTE = 12;
const AUTO_SHIP_DEBOUNCE_MS = 4000;

export type DebugKind = "error" | "warn" | "log" | "network" | "note" | "nav" | "pick";

export interface DebugEntry {
  id: number;
  at: string;
  kind: DebugKind;
  text: string;
  /** Structured extras: status, url, stack, duration. Rendered as JSON in the panel. */
  data?: Record<string, unknown>;
}

type Listener = (entries: DebugEntry[]) => void;

/**
 * One id per page load. It groups a burst of entries into a single sitting, so the transcript I
 * read shows "these fourteen things happened to the same person in the same minute" rather than a
 * flat interleaving of every device that ever reported.
 */
export const SESSION_ID = Math.random().toString(36).slice(2, 10);

let seq = 0;
let entries: DebugEntry[] = [];
const listeners = new Set<Listener>();

let installed = false;
let shipTimer: ReturnType<typeof setTimeout> | null = null;
let pendingAuto: DebugEntry[] = [];
let shippedThisMinute = 0;
let minuteResetAt = Date.now() + 60_000;

export function getEntries(): DebugEntry[] {
  return entries;
}

export function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  fn(entries);
  return () => listeners.delete(fn);
}

export function clearEntries(): void {
  entries = [];
  emit();
}

function emit(): void {
  for (const fn of listeners) fn(entries);
}

/**
 * Reduce to `limit` entries while keeping every pick and note, and the most RECENT context.
 *
 * Chronological order is preserved, so the transcript still reads forwards even when the middle
 * of it has been thinned.
 */
export function trimForReport(list: DebugEntry[], limit: number): DebugEntry[] {
  if (list.length <= limit) return list;
  const pinned = list.filter((e) => NEVER_DROP.includes(e.kind));
  const context = list.filter((e) => !NEVER_DROP.includes(e.kind));
  const room = Math.max(limit - pinned.length, 0);
  const keep = new Set<DebugEntry>([...pinned, ...context.slice(-room)]);
  return list.filter((e) => keep.has(e));
}

export function record(kind: DebugKind, text: string, data?: Record<string, unknown>): DebugEntry {
  const entry: DebugEntry = {
    id: ++seq,
    at: new Date().toISOString(),
    kind,
    text: text.slice(0, 4000),
    data,
  };
  // Ring buffer. A page open all day must not grow without bound — but picks and notes survive
  // the trimming, or they would be lost before Send was ever pressed.
  entries = trimForReport([...entries, entry], MAX_ENTRIES);
  emit();
  if (kind === "error" || kind === "warn") queueAutoShip(entry);
  return entry;
}

/**
 * Strip anything that authenticates. The session token is the one string in this process that
 * must never be written down, and it appears in two places — the header we set, and localStorage.
 */
export function scrub(value: string): string {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, "Bearer [redacted]")
    .replace(/"(token|authorization|password|pin|secret|refresh_token)"\s*:\s*"[^"]*"/gi, '"$1":"[redacted]"');
}

function truncate(value: string): string {
  return value.length > MAX_BODY_CHARS ? `${value.slice(0, MAX_BODY_CHARS)}…[${value.length} chars total]` : value;
}

/** Render a console argument the way a human reads it, not the way `String()` does. */
function stringifyArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return `${arg.name}: ${arg.message}\n${arg.stack ?? ""}`;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function formatArgs(args: unknown[]): string {
  return scrub(args.map(stringifyArg).join(" "));
}

// ─── Shipping ──────────────────────────────────────────────────────────────────────────────────

function queueAutoShip(entry: DebugEntry): void {
  if (Date.now() > minuteResetAt) {
    shippedThisMinute = 0;
    minuteResetAt = Date.now() + 60_000;
  }
  if (shippedThisMinute >= AUTO_SHIP_MAX_PER_MINUTE) return;
  pendingAuto.push(entry);
  if (shipTimer) return;
  shipTimer = setTimeout(() => {
    shipTimer = null;
    const batch = pendingAuto;
    pendingAuto = [];
    if (batch.length === 0) return;
    shippedThisMinute += 1;
    void ship({
      message: `${batch.length} client error(s) — ${batch[0].text.slice(0, 120)}`,
      entries: batch,
      auto: true,
    });
  }, AUTO_SHIP_DEBOUNCE_MS);
}

export interface ShipInput {
  message: string;
  entries: DebugEntry[];
  auto?: boolean;
  /** Kyle's own words, when he pressed the button rather than an error firing. */
  note?: string;
}

/**
 * Send to the server. Uses raw `fetch` deliberately — the instrumented wrapper would record this
 * call, and a failed ship would record its own failure, which would queue another ship.
 */
export async function ship(input: ShipInput): Promise<boolean> {
  const token = typeof localStorage !== "undefined" ? localStorage.getItem("rce_token") : null;
  if (!token) return false;
  const shipped = trimForReport(input.entries, MAX_SHIPPED);
  try {
    const res = await rawFetch("/api/debug/client-log", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        sessionId: SESSION_ID,
        page: typeof location !== "undefined" ? location.pathname : "",
        auto: input.auto ?? false,
        message: input.message.slice(0, 500),
        note: input.note?.slice(0, 4000),
        userAgent: typeof navigator !== "undefined" ? navigator.userAgent : "",
        entries: shipped,
        droppedContextLines: input.entries.length - shipped.length,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** The untouched `fetch`, captured before we patch it. */
let rawFetch: typeof fetch = typeof fetch !== "undefined" ? fetch.bind(globalThis) : (() => {
  throw new Error("fetch unavailable");
}) as typeof fetch;

// ─── Installation ──────────────────────────────────────────────────────────────────────────────

/**
 * Patch the console, the global error handlers, and `fetch`.
 *
 * Idempotent — StrictMode mounts everything twice in development, and a double patch would
 * double every log line and, worse, wrap `fetch` in itself.
 */
export function installDebugBus(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  rawFetch = window.fetch.bind(window);

  const original = {
    error: console.error.bind(console),
    warn: console.warn.bind(console),
    log: console.log.bind(console),
    info: console.info.bind(console),
  };

  console.error = (...args: unknown[]) => {
    record("error", formatArgs(args));
    original.error(...args);
  };
  console.warn = (...args: unknown[]) => {
    record("warn", formatArgs(args));
    original.warn(...args);
  };
  console.log = (...args: unknown[]) => {
    record("log", formatArgs(args));
    original.log(...args);
  };
  console.info = (...args: unknown[]) => {
    record("log", formatArgs(args));
    original.info(...args);
  };

  window.addEventListener("error", (event) => {
    record("error", scrub(`Uncaught ${event.message}`), {
      source: `${event.filename}:${event.lineno}:${event.colno}`,
      stack: event.error instanceof Error ? event.error.stack : undefined,
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    record("error", scrub(`Unhandled promise rejection: ${stringifyArg(reason)}`), {
      stack: reason instanceof Error ? reason.stack : undefined,
    });
  });

  /*
    The network trace. This is the part a screenshot can never show and the part that would have
    named the blank-estimate bug in one line: the request went out, came back 200, and returned
    765 bytes of the wrong document.

    Only FAILURES capture a response body. A successful CRM call returns customer records, and
    there is no reason to copy those into a log to prove the call worked.
  */
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const started = performance.now();
    const method = (init?.method ?? "GET").toUpperCase();
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    // Never trace the ship itself — that is how a logger starts logging its own logging.
    if (url.includes("/debug/client-log")) return rawFetch(input, init);

    try {
      const response = await rawFetch(input, init);
      const ms = Math.round(performance.now() - started);
      if (!response.ok) {
        // Read from a CLONE. Consuming the caller's body would break the caller.
        let body = "";
        try {
          body = truncate(scrub(await response.clone().text()));
        } catch {
          body = "[body unreadable]";
        }
        record("network", `${method} ${url} → ${response.status} ${response.statusText}`, {
          status: response.status,
          ms,
          body,
        });
      } else {
        record("network", `${method} ${url} → ${response.status} (${ms}ms)`, {
          status: response.status,
          ms,
        });
      }
      return response;
    } catch (err) {
      const ms = Math.round(performance.now() - started);
      // A thrown fetch is the offline / DNS / CORS case, and it looks identical to "nothing
      // happened" from the user's side of the screen.
      record("error", scrub(`${method} ${url} → network failure: ${stringifyArg(err)}`), { ms });
      throw err;
    }
  };

  record("log", `debug bus installed · session ${SESSION_ID}`, {
    url: location.href,
    userAgent: navigator.userAgent,
    viewport: `${window.innerWidth}x${window.innerHeight}`,
  });
}
