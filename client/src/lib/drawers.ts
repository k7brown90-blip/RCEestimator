/**
 * Drawer state lives in the URL (2026-09-20, drawers plan Phase 1).
 *
 * Kyle: "There are too many separate pages and I end up having to jump around too much. I
 * can't keep track of where everything is." The rule: THE RECORD CARRIES ITS OWN ACTIONS.
 * Wherever a lead, estimate, job, P.O., receipt or invoice appears, clicking it opens a drawer
 * holding everything that can be done to it. A drawer does not navigate: close it and the
 * list, its scroll position and its filters are exactly as they were.
 *
 * ── WHY THE URL ─────────────────────────────────────────────────────────────────────────────
 *
 * `?po=<id>` on whatever route is open — the pattern `/calendar?schedule=:visitId` already
 * proved (written from four screens, consumed at CalendarPage). It means a drawer can be opened
 * from any screen, handed to another screen as a link, and survives a refresh while it is
 * open, which is what "addressable" buys. Where this differs from the calendar's one-shot
 * param: `?schedule=` is an INSTRUCTION ("open the picker for this job") and is cleared the
 * moment it is obeyed, so back/refresh cannot re-run it. A drawer param is STATE ("this drawer
 * is open"), so it is cleared when the drawer closes, never before — with `replace`, so the
 * dismissed drawer leaves no history entry behind that Back would re-open.
 *
 * ── THE HOST PAGE'S OWN PARAMS ARE NEVER TOUCHED ────────────────────────────────────────────
 *
 * JobsPage reads `?archived`, `?address`, `?open=1`; the estimate builder keeps its whole
 * state in `draft`/`account`/`address`/`tab`. Opening and closing a drawer edits ONE key of
 * the current search params and leaves the rest exactly as found — the functional
 * `setSearchParams` form, never a fresh object.
 *
 * Several drawers can be open at once (`?job=…&po=…`): the DrawerHost renders them in URL
 * order, so the one opened last sits on top and closing it reveals the one beneath.
 */

import { useCallback } from "react";
import { useSearchParams } from "react-router-dom";

export const DRAWER_KINDS = ["po", "job", "estimate", "invoice", "lead", "receipt"] as const;
export type DrawerKind = (typeof DRAWER_KINDS)[number];

export function isDrawerKind(key: string): key is DrawerKind {
  return (DRAWER_KINDS as readonly string[]).includes(key);
}

export type OpenDrawer = { kind: DrawerKind; id: string };

/** The drawers the current URL says are open, in the order they were opened. */
export function openDrawersFrom(params: URLSearchParams): OpenDrawer[] {
  const out: OpenDrawer[] = [];
  for (const [key, value] of params.entries()) {
    if (isDrawerKind(key) && value && !out.some((d) => d.kind === key)) out.push({ kind: key, id: value });
  }
  return out;
}

export function useDrawerParams() {
  const [searchParams, setSearchParams] = useSearchParams();

  const open = useCallback(
    (kind: DrawerKind, id: string) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        // Re-opening the same kind for another record replaces it in place rather than
        // stacking two of the same drawer.
        next.delete(kind);
        next.append(kind, id);
        return next;
      });
    },
    [setSearchParams],
  );

  const close = useCallback(
    (kind: DrawerKind) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete(kind);
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  return { open, close, openDrawers: openDrawersFrom(searchParams) };
}
