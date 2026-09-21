/**
 * The drawer primitive (2026-09-20, drawers plan Phase 1).
 *
 * Kyle: "The drawer allows edits throughout as the user finds and corrects or updates any
 * information." One record's whole action set, opened over whatever list the operator is on,
 * and closed without moving them. Bottom sheet on a phone, right rail on a desktop — the shape
 * the Price Book's `DrawerShell` already had, with its defects fixed:
 *
 * ── PORTALLED TO document.body ──────────────────────────────────────────────────────────────
 * AppShell's content card wraps every page and once carried `backdrop-blur`, which made it the
 * containing block for every `position: fixed` descendant — the sticky bars anchored to the
 * card instead of the viewport and Kyle could not present options (2026-08-21). A 13-line
 * comment now guards that class. A portal makes this drawer immune to that whole class of bug:
 * its DOM parent is <body>, not the card, so no ancestor's paint property can capture it.
 *
 * ── z-[45], CHOSEN DELIBERATELY (PUNCHLIST C2) ───────────────────────────────────────────────
 * The layers in this app: the More sheet's scrim z-30, the More sheet and the PHONE TAB BAR
 * z-40, Modal z-50, the debug panel z-50. The old DrawerShell was z-40 — the same as the tab
 * bar, which is later in the DOM, so the bar painted over the drawer's buttons on a phone.
 * This sits at 45: ABOVE every navigation surface (the bar, the sheet, their scrim) so a
 * drawer's actions are never covered, and BELOW Modal and the debug panel — a Modal raised from
 * inside a drawer (Mark Lost, the duplicate-account picker) must paint over it, and Kyle's
 * element picker must still reach a drawer's controls when he is pointing at a defect. Two
 * drawers share the layer and stack in DOM order, so the one opened last is on top.
 *
 * NO TRANSFORM ON THE PANEL, EVER. A transform (or filter / will-change) would make the panel
 * the containing block for fixed children, which is the AppShell bug again one level down.
 * That is why there is no slide-in animation.
 *
 * ── MOBILE (PUNCHLIST C3) ────────────────────────────────────────────────────────────────────
 * `dvh`, not `vh`: on a phone `100vh` is the viewport with the browser chrome hidden, so a
 * `vh`-sized sheet has its bottom row under the address bar. The CRM is an installed PWA
 * (`display: standalone`) on a notched iPhone, so the sheet also pads its bottom edge by
 * `env(safe-area-inset-bottom)` — the first use of a safe-area inset in this client.
 *
 * ── DIALOG SEMANTICS ────────────────────────────────────────────────────────────────────────
 * role="dialog", aria-modal, labelled by its title. Escape closes (via lib/dialogStack, so a
 * Modal on top of a drawer takes the keypress first), the scrim closes, focus moves into the
 * panel on open, is kept inside it while open (Tab wraps), and returns to whatever opened it on
 * close. The body is scroll-locked while any drawer or Modal is open. None of that is copied
 * from the More sheet, which has none of it.
 */

import { useEffect, useId, useRef } from "react";
import type { PropsWithChildren, ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";
import { useBodyScrollLock, useDialogStack } from "../lib/dialogStack";

/** The layer, as a Tailwind class, exported so the test can compare it with the phone bar's. */
export const DRAWER_Z_CLASS = "z-[45]";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface Props {
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  /** Right-rail width on desktop; the phone sheet is always full width. */
  wide?: boolean;
  /** Slot in the header row, before the Close button — status pills, an "open page" link. */
  headerActions?: ReactNode;
  /**
   * What to focus on open instead of the first focusable — which is the header's Close button,
   * because it is first in the DOM. The search panel (GlobalSearch.tsx) needs its input focused
   * so typing can start at once; a record drawer is happy with the default.
   */
  initialFocus?: RefObject<HTMLElement | null>;
}

export function Drawer({ title, subtitle, onClose, wide = false, headerActions, initialFocus, children }: PropsWithChildren<Props>) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const titleId = useId();

  useDialogStack(onClose);
  useBodyScrollLock();

  // Focus in on open, back out on close.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const panel = panelRef.current;
    if (panel) {
      const first = panel.querySelector<HTMLElement>(FOCUSABLE);
      (initialFocus?.current ?? first ?? panel).focus();
    }
    return () => {
      if (opener && document.contains(opener)) opener.focus();
    };
    // `initialFocus` is a ref object from useRef — stable for the panel's life — so this still
    // runs once, on open.
  }, [initialFocus]);

  // Keep Tab inside the panel while it is open.
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key !== "Tab" || !panelRef.current) return;
    const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (el) => el.offsetParent !== null || el === document.activeElement,
    );
    if (focusable.length === 0) {
      event.preventDefault();
      panelRef.current.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === panelRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div
      data-drawer=""
      className={`fixed inset-0 ${DRAWER_Z_CLASS} flex items-end justify-center md:items-stretch md:justify-end`}
    >
      {/* The scrim. A button, so it is a real click target with an accessible name — a
          different one from the header's Close, so the two never read as one control. */}
      <button
        type="button"
        aria-label="Dismiss"
        data-drawer-scrim=""
        className="absolute inset-0 bg-black/40"
        onClick={onClose}
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={`relative flex max-h-[92dvh] w-full flex-col rounded-t-2xl border-t border-rce-border bg-rce-surface shadow-card outline-none pb-[env(safe-area-inset-bottom)] md:h-dvh md:max-h-dvh md:rounded-none md:border-l md:border-t-0 ${wide ? "md:w-[720px]" : "md:w-[520px]"} md:max-w-[92vw]`}
      >
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-rce-border/70 px-4 py-3">
          <div className="min-w-0">
            <h2 id={titleId} className="font-heading text-lg font-semibold leading-tight">{title}</h2>
            {subtitle ? <div className="mt-0.5 text-xs text-rce-muted">{subtitle}</div> : null}
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {headerActions}
            <button type="button" onClick={onClose} className="btn btn-secondary px-3 py-1 text-sm min-h-0">
              Close
            </button>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
