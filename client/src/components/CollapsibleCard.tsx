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
 *
 * Settings (Kyle, 2026-11-26: "All cards should have be collapsable in the settings"; "All folded"; "Yes,
 * one line each") extends this same card rather than adding a second fold:
 *   - `subtitle`: the card's one-sentence explanation, shown only while open (a folded row is title + status).
 *   - The header button sits inside a real heading (`<h2>`, or `<h3>` for `inner`), so the title keeps its heading role.
 *   - `aria-label` / `data-testid` go to the outer section.
 *   - `lockOpen`: stays open while a show-once secret is on screen. The header is greyed and `lockTitle` is printed on the row
 *     (visible text, not only a hover tooltip), so a click that does nothing says why.
 *   - `attention`: a live warning (agents off, events not sent, unsaved edits). The card opens by itself the
 *     moment it is true, and on load, whatever was stored; the person can still fold it by hand.
 *   - `open` + `onOpenChange`: the parent holds the state (nothing stored), for rows whose identity is not an id
 *     (a financing plan that is moved or removed).
 *   - `inner`: a plain frame and a small heading for a fold inside another card (a plan, an agent).
 * A Settings card is converted INSIDE its own component, so its hooks and typed edits stay above the fold.
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
  subtitle,
  defaultOpen = false,
  compact = false,
  nested = false,
  inner = false,
  attention = false,
  lockOpen = false,
  lockTitle,
  open: controlledOpen,
  onOpenChange,
  className = "",
  children,
  "aria-label": ariaLabel,
  "data-testid": testId,
}: {
  id: string;
  title: ReactNode;
  /** One line that stays visible when folded — counts, amounts, "none unresolved". */
  summary?: ReactNode;
  /** One plain sentence under the header, shown only while the card is open. */
  subtitle?: ReactNode;
  /** The page's proposal; a choice Kyle has made on this card (localStorage) wins over it. */
  defaultOpen?: boolean;
  /** Smaller header for a strip-sized card (the Balances row). */
  compact?: boolean;
  /** The body draws its own `.card`; flatten it into this one. */
  nested?: boolean;
  /** A fold inside another card: a plain frame (no `.card` shadow) and a small `<h3>` heading. */
  inner?: boolean;
  /** A live warning: the card opens by itself the moment this is true (and on load), and can still be folded by hand. */
  attention?: boolean;
  /** Stay open and refuse to fold (a show-once secret is on screen). */
  lockOpen?: boolean;
  /** Why the header will not fold right now (the tooltip while `lockOpen`). */
  lockTitle?: string;
  /** Held by the parent instead of localStorage; pass with `onOpenChange`. */
  open?: boolean;
  onOpenChange?: (next: boolean) => void;
  /** Extra classes on the outer section (a tone, e.g. the amber receipts-to-review frame). */
  className?: string;
  children: ReactNode;
  "aria-label"?: string;
  "data-testid"?: string;
}) {
  const controlled = controlledOpen !== undefined;
  // A live warning opens the card on load even over a stored fold; otherwise the stored choice, then the page's proposal.
  const [stored, setStored] = useState<boolean | null>(() => (attention ? true : readStored(id)));
  // A warning that appears while the page is open opens the card too (state adjusted during render, not in an effect).
  const [sawAttention, setSawAttention] = useState(attention);
  if (attention !== sawAttention) {
    setSawAttention(attention);
    if (attention) setStored(true);
  }
  const open = lockOpen ? true : controlled ? controlledOpen : stored ?? defaultOpen;
  const bodyId = `collapsible-${id}`;
  const titleId = `${bodyId}-title`;
  const summaryId = `${bodyId}-summary`;
  const lockId = `${bodyId}-lock`;
  const lockReason = lockOpen && lockTitle ? lockTitle : null;
  const hasSummary = summary !== undefined && summary !== null && summary !== "";
  const toggle = () => {
    if (lockOpen) return;
    const next = !open;
    if (controlled) {
      onOpenChange?.(next);
      return;
    }
    setStored(next);
    writeStored(id, next);
  };
  const Heading = inner ? "h3" : "h2";
  const titleClass = compact
    ? "text-xs font-semibold uppercase tracking-wide text-rce-soft"
    : inner
      ? "text-sm font-semibold"
      : "text-lg font-semibold";
  const frame = inner ? `rounded-lg border border-rce-border bg-white ${compact ? "p-3" : "p-4"}` : `card ${compact ? "p-3" : "p-4"}`;

  return (
    <section className={`${frame} ${className}`} aria-label={ariaLabel} data-testid={testId}>
      <Heading className="m-0">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        // The heading and the button are named by the title alone; the status line is the button's description.
        aria-labelledby={titleId}
        aria-describedby={[hasSummary ? summaryId : null, lockReason ? lockId : null].filter(Boolean).join(" ") || undefined}
        aria-disabled={lockOpen || undefined}
        title={lockOpen ? lockTitle : undefined}
        onClick={toggle}
        className={`flex w-full items-center justify-between gap-3 text-left ${lockOpen ? "cursor-not-allowed opacity-60" : ""}`}
      >
        <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <span id={titleId} className={titleClass}>
            {title}
          </span>
          {hasSummary && (
            <span id={summaryId} className="min-w-0 max-w-full truncate text-xs text-rce-muted">{summary}</span>
          )}
          {lockReason && (
            <span id={lockId} className="min-w-0 max-w-full text-xs font-semibold text-amber-800" data-testid={`${bodyId}-lock-reason`}>{lockReason}</span>
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
      </Heading>
      {open && (
        <div id={bodyId} className={`${compact ? "mt-1" : "mt-2"} ${nested ? NESTED_FLATTEN : ""}`}>
          {subtitle !== undefined && subtitle !== null && subtitle !== "" && <p className="mb-3 text-sm text-rce-muted">{subtitle}</p>}
          {children}
        </div>
      )}
    </section>
  );
}
