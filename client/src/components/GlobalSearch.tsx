/**
 * Global search (2026-09-20, drawers plan Phase 5) — the box and the results.
 *
 * Kyle: "There are too many separate pages and I end up having to jump around too much. I can't
 * keep track of where everything is." The drawers made every record reachable; this makes every
 * record FINDABLE from every tab. Type a name, an address, phone digits, an estimate number or a
 * P.O. number; a result opens the record's DRAWER on the route you are already on
 * (lib/drawers.ts) — an account, which has no drawer, opens its page. Ranking, the caps and the
 * no-token rule live on the server (src/services/globalSearch.ts); this renders what it returns
 * in the order it returns it.
 *
 * ── WHERE IT LIVES ──────────────────────────────────────────────────────────────────────────
 * The trigger is a BUTTON, in two places: the top of the desktop sidebar (with Ctrl / ⌘ K) and
 * a strip above the content card on a phone. The input itself lives INSIDE the results drawer:
 * `Drawer` covers the page with a scrim and keeps focus inside its panel, so an input outside
 * it could not be typed into while results showed. The drawer is told to focus the input on
 * open (`initialFocus`) — its default, the first focusable, is the header's Close button.
 *
 * PHONE, decided deliberately: the bar is five tabs and More and never grows (Kyle, 2026-09-10);
 * the More sheet is two taps away and hidden — the opposite of "where is it"; a floating button
 * would sit where the debug console's already does. A strip at the top of every page is one
 * tap, visible on every tab, and scrolls away with the content. It costs ~44px at the top of a
 * phone screen. (iOS only raises the keyboard for a focus() made inside the tap itself, so on a
 * phone the input may need a second tap — a platform limit, not a bug to fix here.)
 *
 * A result with a drawer leaves this panel OPEN underneath: close the record and the results
 * are still there. A result with an href navigates, and the route change closes the panel
 * (AppShell keys it to the pathname it was opened on).
 */

import { useEffect, useRef, useState } from "react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { useDrawerParams } from "../lib/drawers";
import type { SearchKind, SearchResult } from "../lib/types";
import { Drawer } from "./Drawer";

export const SEARCH_HINT = "Names, addresses, phone digits, estimate or P.O. numbers";

/** Server-side MIN_QUERY_LENGTH: nothing is asked for under this. */
const MIN_CHARS = 2;
const DEBOUNCE_MS = 250;

const KIND_LABEL: Record<SearchKind, string> = {
  account: "Account", property: "Address", lead: "Lead", job: "Job", estimate: "Estimate", po: "P.O.",
};
const KIND_PLURAL: Record<SearchKind, string> = {
  account: "accounts", property: "addresses", lead: "leads", job: "jobs", estimate: "estimates", po: "P.O.s",
};

function MagnifierIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="8.5" cy="8.5" r="5.5" />
      <path d="M13 13l4.5 4.5" strokeLinecap="round" />
    </svg>
  );
}

/** The trigger. `sidebar` sits on the dark desktop rail; `phone` is the light strip above the page. */
export function GlobalSearchButton({ variant, onOpen }: { variant: "sidebar" | "phone"; onOpen: () => void }) {
  if (variant === "sidebar") {
    return (
      <button
        type="button"
        aria-label="Search"
        onClick={onOpen}
        className="mb-2 flex w-full items-center gap-2 rounded-lg border border-white/15 bg-black/20 px-3 py-2 text-sm text-rce-navText transition hover:bg-white/10"
      >
        <MagnifierIcon />
        <span className="flex-1 text-left">Search</span>
        <kbd className="rounded border border-white/20 px-1.5 py-0.5 font-sans text-[10px] text-rce-navText/80">Ctrl K</kbd>
      </button>
    );
  }
  return (
    <button
      type="button"
      aria-label="Search"
      onClick={onOpen}
      className="flex w-full items-center gap-2 rounded-xl border border-rce-border bg-rce-surface px-3 py-2.5 text-left text-sm text-rce-muted shadow-card"
    >
      <MagnifierIcon />
      <span className="min-w-0 flex-1 truncate">Search names, addresses, numbers</span>
    </button>
  );
}

/** The results drawer: the input at the top, results beneath, one call per pause in typing. */
export function GlobalSearchPanel({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const drawers = useDrawerParams();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [text, setText] = useState("");
  // What is actually asked for — `text` after a pause. Set from the input's own timer (never
  // from an effect), so typing "Godwin" is one request, not six.
  const [q, setQ] = useState("");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const onChange = (value: string) => {
    setText(value);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setQ(value.trim().replace(/\s+/g, " ")), DEBOUNCE_MS);
  };

  const enabled = q.length >= MIN_CHARS;
  const { data, isFetching, error } = useQuery({
    queryKey: ["search", { q }],
    queryFn: () => api.search(q),
    enabled,
    // The last results stay on screen while the next keystroke's load — no flash to empty.
    placeholderData: keepPreviousData,
  });
  const results = enabled ? (data?.results ?? []) : [];
  const moreKinds = enabled && data ? (Object.keys(data.more) as SearchKind[]).filter((k) => data.more[k]) : [];

  const choose = (r: SearchResult) => {
    if (r.drawer) {
      drawers.open(r.drawer.kind, r.drawer.id);
      return;
    }
    if (r.href) {
      onClose();
      navigate(r.href);
    }
  };

  return (
    <Drawer title="Search" subtitle={SEARCH_HINT} onClose={onClose} initialFocus={inputRef}>
      <input
        ref={inputRef}
        type="search"
        value={text}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && results[0]) {
            e.preventDefault();
            choose(results[0]);
          }
        }}
        placeholder="Godwin · 108 Maple · 555-0142 · 2026-1010 · PO-2026-0021"
        aria-label="Search"
        autoComplete="off"
        enterKeyHint="search"
        className="field w-full"
      />

      <div className="mt-3 space-y-1" aria-live="polite">
        {error ? <p className="text-sm text-rce-danger">{(error as Error).message}</p> : null}
        {!enabled ? (
          <p className="text-xs text-rce-muted">Type at least {MIN_CHARS} characters. A whole estimate or P.O. number comes first; then names and addresses.</p>
        ) : null}
        {enabled && !isFetching && data && results.length === 0 ? (
          <p className="text-sm text-rce-muted">Nothing matches “{data.q}”.</p>
        ) : null}
        {results.length > 0 ? (
          <ul className="divide-y divide-rce-border/60">
            {results.map((r) => (
              <li key={`${r.kind}:${r.id}`}>
                <button
                  type="button"
                  onClick={() => choose(r)}
                  data-search-result={r.kind}
                  className="flex w-full flex-col items-start gap-0.5 rounded-lg px-2 py-2 text-left hover:bg-rce-bg"
                >
                  <span className="flex w-full items-center gap-2">
                    <span className="shrink-0 rounded bg-rce-bg px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-rce-muted">
                      {KIND_LABEL[r.kind]}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm font-medium text-rce-text">{r.title}</span>
                    {r.status ? (
                      <span className="shrink-0 text-[10px] font-semibold uppercase text-rce-muted">{r.status.replaceAll("_", " ")}</span>
                    ) : null}
                  </span>
                  {r.subtitle ? <span className="w-full truncate text-xs text-rce-muted">{r.subtitle}</span> : null}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {moreKinds.length > 0 ? (
          <p className="pt-1 text-xs text-rce-muted">
            More {moreKinds.map((k) => KIND_PLURAL[k]).join(", ")} than shown — narrow the search.
          </p>
        ) : null}
        {enabled && data && !data.indexed ? (
          <p className="pt-1 text-xs text-rce-muted">Searching without its index (pg_trgm is not installed on the database) — still works, slower.</p>
        ) : null}
      </div>
    </Drawer>
  );
}
