/**
 * A card that folds to its header (Kyle, 2026-09-10: "I like the collapsible idea
 * it will be easier to keep the clutter down").
 *
 * The header row is always visible: the title, a one-line `summary` (counts and
 * amounts, so a folded card still says what is inside), and a chevron. Whether
 * the card is open is remembered per `id` in localStorage (`rce.card.<id>`), and
 * a remembered choice beats `defaultOpen` — the page proposes (open when there is
 * something urgent, folded otherwise), Kyle disposes. The body is not mounted
 * while folded, so whatever a card shows in its summary must come from a query
 * that lives OUTSIDE the body (the card's own hook, or the page's).
 *
 * `nested` is for a card whose body is a component that draws its own `.card`
 * frame and heading and cannot be edited right now (TrucksCards.tsx, 2026-09-10):
 * the inner frame is flattened and its heading hidden so the two read as one
 * card. Give the inner component a frameless mode and drop `nested` when it frees up.
 */

import { useState } from "react";
import type { ReactNode } from "react";

const storageKey = (id: string) => `rce.card.${id}`;

function readStored(id: string): boolean | null {
  try {
    const v = localStorage.getItem(storageKey(id));
    return v === "1" ? true : v === "0" ? false : null;
  } catch {
    return null;
  }
}

function writeStored(id: string, open: boolean): void {
  try {
    localStorage.setItem(storageKey(id), open ? "1" : "0");
  } catch {
    // Private mode / storage blocked — the card still toggles, it just forgets.
  }
}

/** Strip an inner `.card` and hide its heading so it sits inside this card as plain content. */
const NESTED_FLATTEN =
  "[&>.card]:rounded-none [&>.card]:border-0 [&>.card]:bg-transparent [&>.card]:p-0 [&>.card]:shadow-none " +
  "[&>.card_h2]:hidden [&>.card>span:first-child]:hidden";

export function CollapsibleCard({
  id,
  title,
  summary,
  defaultOpen = false,
  compact = false,
  nested = false,
  className = "",
  children,
}: {
  id: string;
  title: ReactNode;
  /** One line that stays visible when folded — counts, amounts, "none unresolved". */
  summary?: ReactNode;
  /** The page's proposal; a choice Kyle has made on this card (localStorage) wins over it. */
  defaultOpen?: boolean;
  /** Smaller header for a strip-sized card (the Balances row). */
  compact?: boolean;
  /** The body draws its own `.card`; flatten it into this one. */
  nested?: boolean;
  /** Extra classes on the outer section (a tone, e.g. the amber receipts-to-review frame). */
  className?: string;
  children: ReactNode;
}) {
  const [stored, setStored] = useState<boolean | null>(() => readStored(id));
  const open = stored ?? defaultOpen;
  const bodyId = `collapsible-${id}`;
  const toggle = () => {
    const next = !open;
    setStored(next);
    writeStored(id, next);
  };

  return (
    <section className={`card ${compact ? "p-3" : "p-4"} ${className}`}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={toggle}
        className="flex w-full items-center justify-between gap-3 text-left"
      >
        <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <span className={compact ? "text-xs font-semibold uppercase tracking-wide text-rce-soft" : "text-lg font-semibold"}>
            {title}
          </span>
          {summary !== undefined && summary !== null && summary !== "" && (
            <span className="min-w-0 max-w-full truncate text-xs text-rce-muted">{summary}</span>
          )}
        </span>
        <svg
          aria-hidden="true"
          viewBox="0 0 20 20"
          className={`h-4 w-4 shrink-0 text-rce-soft transition-transform ${open ? "rotate-180" : ""}`}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M5 8l5 5 5-5" />
        </svg>
      </button>
      {open && (
        <div id={bodyId} className={`${compact ? "mt-1" : "mt-2"} ${nested ? NESTED_FLATTEN : ""}`}>
          {children}
        </div>
      )}
    </section>
  );
}
